# Misskey登录流程详解

## 概述

Misskey采用了一种基于状态机模式的多步骤登录流程，支持多种认证方式，包括：
- 普通密码登录
- 双因素认证(2FA)
- WebAuthn安全密钥认证
- 无密码登录

本文档详细解析Misskey的登录流程实现原理、代码结构和认证机制。

## 登录流程的状态机设计

Misskey的登录系统采用状态机设计模式，每次API请求都会返回当前登录流程的状态和下一步操作指示。

### 核心状态响应类型

```typescript
/**
 * 登录流程响应类型
 * 描述登录过程中的各种状态和下一步操作
 */
export type SigninFlowResponse = {
    finished: true;          // 登录完成
    id: User['id'];          // 用户ID
    i: string;               // 认证令牌
} | {
    finished: false;         // 登录未完成
    next: 'captcha' | 'password' | 'totp'; // 下一步：验证码、密码或TOTP
} | {
    finished: false;         // 登录未完成
    next: 'passkey';         // 下一步：密钥认证
    authRequest: PublicKeyCredentialRequestOptionsJSON; // WebAuthn认证请求参数
};
```

这个类型定义了三种可能的状态：
1. 登录完成：返回用户ID和访问令牌
2. 需要继续普通验证：如验证码、密码或TOTP
3. 需要WebAuthn密钥验证：包含WebAuthn认证所需参数

## 完整登录流程示例

### 基本登录流程（无2FA）

1. **第一步：用户输入用户名**

   **前端操作**：
   用户在登录页面输入用户名，点击"下一步"

   **前端代码**：
   ```javascript
   // 发送包含用户名的请求
   const response = await fetch('/api/signin', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ username: 'testuser' })
   });
   const data = await response.json();
   ```

   **后端处理**：
   ```typescript
   // 如果没有提供密码，确定下一步登录流程
   if (password == null) {
     reply.code(200);
     if (profile.twoFactorEnabled) {
       // 如果启用了双因素认证，下一步是输入密码
       return {
         finished: false,
         next: 'password',
       } satisfies Misskey.entities.SigninFlowResponse;
     } else {
       // 否则，下一步是验证码
       return {
         finished: false,
         next: 'captcha',
       } satisfies Misskey.entities.SigninFlowResponse;
       // 前端拿到这个返回值之后，会根据next的值，跳转到对应的页面
     }
   }
   ```

   **后端返回**：
   ```json
   {
     "finished": false,
     "next": "captcha"
   }
   ```

   **前端响应**：
   根据`next`字段值，前端显示验证码界面

2. **第二步：用户完成验证码并输入密码**

   **前端操作**：
   用户完成验证码挑战，输入密码，点击"登录"

   **前端代码**：
   ```javascript
   const response = await fetch('/api/signin', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       username: 'testuser',
       password: 'mypassword',
       'g-recaptcha-response': captchaToken
     })
   });
   const data = await response.json();
   ```

   **后端处理**：
   ```typescript
   // 没有启用双因素认证的情况处理
   if (!profile.twoFactorEnabled) {
     // 验证验证码...
     
     // 如果密码匹配，登录成功
     if (same) {
       return this.signinService.signin(request, reply, user);
     } else {
       // 密码不匹配，登录失败
       return await fail(403, {
         id: '932c904e-9460-45b7-9ce6-7ed33be7eb2c',
       });
     }
   }
   ```

   **后端返回（成功情况）**：
   ```json
   {
     "finished": true,
     "id": "user123",
     "i": "access_token_xyz"
   }
   ```

   **前端响应**：
   - 保存访问令牌
   - 将用户重定向到主页面

### 双因素认证(2FA)流程

1. **第一步：用户输入用户名**

   **后端返回**：
   ```json
   {
     "finished": false,
     "next": "password"
   }
   ```

2. **第二步：用户输入密码**

   **前端代码**：
   ```javascript
   const response = await fetch('/api/signin', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       username: 'testuser',
       password: 'mypassword'
     })
   });
   const data = await response.json();
   ```

   **后端处理**：
   ```typescript
   // 处理启用了双因素认证的情况
   if (!token) {
     // 其他情况，如传统的双因素认证
     if (!same || !profile.twoFactorEnabled) {
       return await fail(403, {
         id: '932c904e-9460-45b7-9ce6-7ed33be7eb2c',
       });
     } else {
       // 密码正确且启用了双因素认证，下一步是输入TOTP
       reply.code(200);
       return {
         finished: false,
         next: 'totp',
       } satisfies Misskey.entities.SigninFlowResponse;
     }
   }
   ```

   **后端返回**：
   ```json
   {
     "finished": false,
     "next": "totp"
   }
   ```

3. **第三步：用户输入TOTP验证码**

   **前端代码**：
   ```javascript
   const response = await fetch('/api/signin', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       username: 'testuser',
       password: 'mypassword',
       token: '123456' // TOTP验证码
     })
   });
   const data = await response.json();
   ```

   **后端处理**：
   ```typescript
   // 处理启用了双因素认证的情况
   if (token) {
     // 如果提供了令牌，首先验证密码
     if (!same) {
       return await fail(403, {
         id: '932c904e-9460-45b7-9ce6-7ed33be7eb2c',
       });
     }

     // 验证双因素认证令牌
     try {
       await this.userAuthService.twoFactorAuthenticate(profile, token);
     } catch (e) {
       return await fail(403, {
         id: 'cdf1235b-ac71-46d4-a3a6-84ccce48df6f',
       });
     }

     // 验证成功，登录用户
     return this.signinService.signin(request, reply, user);
   }
   ```

   **后端返回（成功情况）**：
   ```json
   {
     "finished": true,
     "id": "user123",
     "i": "access_token_xyz"
   }
   ```

### WebAuthn安全密钥流程

1. **前两步与常规流程相同**

2. **检测到安全密钥**：

   **后端处理**：
   ```typescript
   // 检查用户是否有安全密钥
   const securityKeysAvailable = await this.userSecurityKeysRepository.countBy({ userId: user.id }).then(result => result >= 1);
   
   // 如果用户有安全密钥
   if (securityKeysAvailable) {
     // 如果用户有安全密钥，验证密码（除非启用了无密码登录）
     if (!same && !profile.usePasswordLessLogin) {
       return await fail(403, {
         id: '932c904e-9460-45b7-9ce6-7ed33be7eb2c',
       });
     }

     // 初始化WebAuthn认证
     const authRequest = await this.webAuthnService.initiateAuthentication(user.id);

     reply.code(200);
     return {
       finished: false,
       next: 'passkey',
       authRequest,
     } satisfies Misskey.entities.SigninFlowResponse;
   }
   ```

   **后端返回**：
   ```json
   {
     "finished": false,
     "next": "passkey",
     "authRequest": {
       "challenge": "random_challenge_string",
       "rpId": "example.com",
       "allowCredentials": [
         { "id": "credential_id_1", "type": "public-key" }
       ],
       // 其他WebAuthn参数
     }
   }
   ```

3. **前端触发WebAuthn认证**：

   **前端代码**：
   ```javascript
   // 使用WebAuthn API触发安全密钥验证
   const credential = await navigator.credentials.get({
     publicKey: convertAuthRequestToPublicKeyCredentialRequestOptions(data.authRequest)
   });
   
   // 发送凭证到服务器
   const response = await fetch('/api/signin', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       username: 'testuser',
       password: 'mypassword',
       credential: credential
     })
   });
   ```

   **后端处理**：
   ```typescript
   else if (body.credential) {
     // 如果提供了WebAuthn凭证，验证密码（除非启用了无密码登录）
     if (!same && !profile.usePasswordLessLogin) {
       return await fail(403, {
         id: '932c904e-9460-45b7-9ce6-7ed33be7eb2c',
       });
     }

     // 验证WebAuthn认证
     const authorized = await this.webAuthnService.verifyAuthentication(user.id, body.credential);

     if (authorized) {
       // 验证成功，登录用户
       return this.signinService.signin(request, reply, user);
     } else {
       // 验证失败
       return await fail(403, {
         id: '93b86c4b-72f9-40eb-9815-798928603d1e',
       });
     }
   }
   ```

## 错误处理机制

Misskey的登录系统有完善的错误处理机制，使用唯一错误ID标识不同类型的错误：

```typescript
/**
 * 处理登录失败
 * @param status HTTP状态码（可选）
 * @param failure 失败信息（可选）
 * @returns 格式化的错误响应
 */
const fail = async (status?: number, failure?: { id: string; }) => {
  // 记录登录失败历史
  await this.signinsRepository.insert({
    id: this.idService.gen(),
    userId: user.id,
    ip: request.ip,
    headers: request.headers as any,
    success: false,
  });

  return error(status ?? 500, failure ?? { id: '4e30e80c-e338-45a0-8c8f-44455efa3b76' });
};
```

常见错误ID及其含义：
- `6cc579cc-885d-43d8-95c2-b8c7fc963280`: 用户不存在
- `e03a5f46-d309-4865-9b69-56282d94e1eb`: 用户被暂停
- `932c904e-9460-45b7-9ce6-7ed33be7eb2c`: 密码不匹配
- `cdf1235b-ac71-46d4-a3a6-84ccce48df6f`: 双因素认证失败
- `93b86c4b-72f9-40eb-9815-798928603d1e`: WebAuthn认证失败
- `4e30e80c-e338-45a0-8c8f-44455efa3b76`: 通用错误

## 速率限制保护

为防止暴力破解攻击，Misskey实现了登录尝试的速率限制：

```typescript
try {
  // 速率限制：每秒不超过1次尝试，每小时不超过10次尝试
  await this.rateLimiterService.limit({ key: 'signin', duration: 60 * 60 * 1000, max: 10, minInterval: 1000 }, getIpHash(request.ip));
} catch (err) {
  // 如果超出限制，返回429状态码
  reply.code(429);
  return {
    error: {
      message: 'Too many failed attempts to sign in. Try again later.',
      code: 'TOO_MANY_AUTHENTICATION_FAILURES',
      id: '22d05606-fbcf-421a-a2db-b32610dcfd1b',
    },
  };
}
```

这个机制确保：
- 每秒最多1次登录尝试
- 每小时最多10次登录尝试
- 超出限制会返回429错误

## 认证令牌机制

Misskey使用自定义令牌系统而非标准的JWT：

### 令牌生成

```typescript
// 在SignupService.ts中
const secret = generateNativeUserToken();

// 存储令牌
account = await transactionalEntityManager.save(new MiUser({
  id: this.idService.gen(),
  username: username,
  usernameLower: username.toLowerCase(),
  host: this.utilityService.toPunyNullable(host),
  token: secret,  // 令牌直接存储在用户记录中
}));
```

### 与JWT的比较

#### Misskey的认证流程：
1. 用户完成多步骤登录流程
2. 服务器生成一个随机令牌并存储在数据库中
3. 令牌返回给客户端
4. 客户端在后续请求中使用该令牌
5. 服务器通过查询数据库验证令牌

#### JWT认证流程：
1. 用户登录
2. 服务器创建并签名JWT（包含用户信息和过期时间）
3. JWT返回给客户端
4. 客户端在后续请求中使用JWT
5. 服务器通过验证签名和检查内容来验证JWT，无需查询数据库

#### 自定义令牌系统的优缺点：

**优点**：
- 完全可控的令牌格式和生命周期
- 可以立即撤销任何令牌
- 可能更简单的实现

**缺点**：
- 需要数据库查询来验证每个请求
- 缺乏JWT提供的标准化和工具支持
- 可能在大规模部署时效率较低

## 无密码登录机制

Misskey支持基于WebAuthn的无密码登录：

```typescript
// 如果提供了WebAuthn凭证，验证密码（除非启用了无密码登录）
if (!same && !profile.usePasswordLessLogin) {
  return await fail(403, {
    id: '932c904e-9460-45b7-9ce6-7ed33be7eb2c',
  });
}
```

当用户启用`usePasswordLessLogin`选项后，可以完全跳过密码验证，直接使用WebAuthn安全密钥进行身份验证。

## 代码架构与依赖注入

Misskey使用NestJS框架，采用依赖注入模式组织代码：

```typescript
@Injectable()
export class SigninApiService {
  constructor(
    @Inject(DI.config)
    private config: Config, // 应用配置

    @Inject(DI.meta)
    private meta: MiMeta, // 元数据设置

    @Inject(DI.usersRepository)
    private usersRepository: UsersRepository, // 用户存储库

    // 其他依赖...
  ) {
  }
}
```

主要依赖项包括：
- 配置服务
- 元数据服务
- 用户存储库
- 用户资料存储库
- 安全密钥存储库
- ID生成服务
- 速率限制服务
- 登录服务
- 用户认证服务
- WebAuthn服务
- 验证码服务

## 总结

Misskey的登录系统是一个灵活、安全的多步骤认证系统，具有以下特点：

1. **状态机设计**：使用状态响应引导客户端完成多步骤登录流程
2. **多种认证方式**：支持密码、双因素认证、WebAuthn安全密钥
3. **自定义令牌系统**：使用自定义令牌而非JWT，提供更灵活的控制
4. **安全保护措施**：包括速率限制、密码哈希、错误日志等
5. **无密码选项**：支持现代的无密码登录方式

这种设计使Misskey能够适应各种安全需求，同时为用户提供灵活的登录选项。 
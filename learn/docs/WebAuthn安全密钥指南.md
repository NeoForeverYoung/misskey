# WebAuthn安全密钥指南

## 基本概念

WebAuthn（Web Authentication）是一种现代化的身份验证标准，允许用户使用安全密钥进行身份验证，而不是（或者作为补充）传统的密码。在Misskey项目中，安全密钥是指：

1. **物理安全密钥**：如YubiKey、Google Titan等USB设备
2. **生物识别设备**：如指纹传感器、面部识别系统
3. **手机上的安全元素**：如用于FIDO2/WebAuthn的安全芯片
4. **平台认证器**：如Windows Hello、Apple Touch ID/Face ID

## 与传统密码的关系

安全密钥与传统密码的关系可以是：

1. **补充关系**：作为第二因素（双因素认证），与密码一起使用
2. **替代关系**：在无密码登录模式下，完全替代密码

## 在Misskey中的实现

### 1. 检查用户是否有安全密钥

```typescript
// 从SigninApiService.ts
// 检查用户是否有安全密钥
const securityKeysAvailable = await this.userSecurityKeysRepository.countBy({ userId: user.id }).then(result => result >= 1);
```

这段代码查询数据库，检查用户是否注册了至少一个安全密钥。

### 2. 基于安全密钥的登录流程

```typescript
// 从SigninApiService.ts
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
  };
}
```

这段代码展示了当用户有安全密钥时的登录流程：
- 如果用户没有启用无密码登录，仍需验证密码
- 然后初始化WebAuthn认证流程
- 返回认证请求给客户端，指示下一步是使用安全密钥（passkey）

### 3. 使用WebAuthn凭证进行验证

```typescript
// 从SigninApiService.ts
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

这段代码处理客户端提交的WebAuthn凭证：
- 验证WebAuthn凭证是否有效
- 如果有效，允许用户登录
- 如果无效，返回验证失败错误

## WebAuthn的工作原理

### 注册流程

1. **服务器创建挑战**：生成一个随机挑战和用户信息
2. **客户端处理**：浏览器调用认证器（安全密钥）生成公私钥对
3. **认证器操作**：用户通过触摸设备、输入PIN或生物识别进行确认
4. **凭证创建**：认证器创建凭证并用私钥签名
5. **服务器验证**：服务器验证签名并存储公钥

### 认证流程

1. **服务器创建挑战**：生成一个随机挑战
2. **客户端处理**：浏览器请求认证器使用之前注册的凭证
3. **认证器操作**：用户通过触摸设备、输入PIN或生物识别进行确认
4. **签名创建**：认证器使用私钥对挑战进行签名
5. **服务器验证**：服务器使用存储的公钥验证签名

## 安全优势

WebAuthn安全密钥相比传统密码有以下优势：

1. **抗钓鱼**：凭证绑定到特定域名，防止钓鱼网站窃取
2. **抗中间人**：使用公钥加密，无法通过拦截传输数据获取凭证
3. **抗暴力破解**：通常需要物理接触或生物识别，无法远程破解
4. **无共享密钥**：服务器只存储公钥，即使数据库泄露也不会泄露认证凭证
5. **用户体验**：可以实现无密码登录，提升用户体验

## 在Misskey中启用无密码登录

Misskey支持通过安全密钥实现无密码登录：

```typescript
// 相关代码片段
if (!same && !profile.usePasswordLessLogin) {
  // 如果密码不匹配且未启用无密码登录，则失败
  return await fail(403, { id: '932c904e-9460-45b7-9ce6-7ed33be7eb2c' });
}
```

用户可以在设置中启用`usePasswordLessLogin`选项，之后可以完全使用安全密钥进行登录，无需输入密码。

## 实现注意事项

1. **降级攻击防护**：确保无法绕过安全密钥验证回退到弱验证方式
2. **多设备支持**：允许用户注册多个安全密钥，以防主要设备丢失
3. **恢复机制**：提供备用验证方式，防止用户因设备丢失无法访问账户
4. **用户教育**：向用户解释安全密钥的优势和使用方法

## 结论

WebAuthn安全密钥代表了身份验证的未来方向，提供了比传统密码更高的安全性和更好的用户体验。在Misskey项目中，安全密钥已经得到了良好的集成，既可以作为双因素认证的一部分，也可以完全替代密码，实现无密码登录。

随着WebAuthn标准的普及和硬件支持的增加，我们可以期待更多系统采用这种更安全的身份验证方式，逐步减少对传统密码的依赖。 
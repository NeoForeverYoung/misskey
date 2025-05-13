# bcrypt密码安全指南

## 基本概念

bcrypt是一种密码哈希函数，专为密码存储设计，具有以下特点：

1. **内置盐值处理**：自动为每个密码生成并管理唯一的盐值
2. **计算成本可调整**：通过rounds参数控制哈希计算的复杂度
3. **抗暴力破解**：算法设计使其计算速度较慢，增加暴力破解难度
4. **抗彩虹表攻击**：由于使用随机盐值，预计算攻击无效

## 在Misskey项目中的实现

### 1. 密码哈希创建和存储

在用户注册或更改密码时，使用bcrypt对密码进行哈希处理：

```typescript
// 从SignupService.ts
// Generate hash of password
const salt = await bcrypt.genSalt(12); // 生成盐值，12是轮次数
const hash = await bcrypt.hash(password, salt); // 使用盐值计算哈希

// 存储哈希到数据库
await transactionalEntityManager.save(new MiUserProfile({
  userId: account.id,
  autoAcceptFollowed: true,
  password: hash, // 存储的是包含盐值的完整哈希字符串
}));
```

```typescript
// 从change-password.ts
// Generate hash of password
const salt = await bcrypt.genSalt(12);
const hash = await bcrypt.hash(ps.newPassword, salt);

await this.userProfilesRepository.update(me.id, {
  password: hash,
});
```

### 2. 密码验证过程

在用户登录时，使用bcrypt.compare函数验证密码：

```typescript
// 从SigninApiService.ts
// 比较提供的密码与存储的密码哈希
const same = await bcrypt.compare(password, profile.password!);

if (same) {
  // 密码匹配，允许登录
  return this.signinService.signin(request, reply, user);
} else {
  // 密码不匹配，登录失败
  return await fail(403, {
    id: '932c904e-9460-45b7-9ce6-7ed33be7eb2c',
  });
}
```

## bcrypt工作原理

### 盐值处理

bcrypt的一个主要特点是盐值直接嵌入在哈希结果中，格式如下：

```
$2a$12$[盐值][哈希结果]
```

其中：
- `$2a$`：算法版本标识符
- `12$`：轮次数（计算复杂度）
- `[盐值]`：随机生成的盐
- `[哈希结果]`：最终的哈希值

### 为什么不需要单独存储盐值

在bcrypt中，不需要单独存储盐值的原因是：

1. 盐值已经内置在最终的哈希字符串中
2. `bcrypt.compare`函数会自动从存储的哈希中提取盐值
3. 然后对用户输入的密码应用相同的盐值和哈希过程
4. 最后比较生成的哈希结果是否匹配

这种设计简化了开发，也确保了每个密码都使用唯一的盐值。

## 安全增强建议

### 1. 增加轮次数

通过增加`genSalt`的参数值，可以提高哈希的复杂度：

```typescript
// 原始代码
const salt = await bcrypt.genSalt(8);

// 更安全的版本
const salt = await bcrypt.genSalt(12); // 或更高，取决于服务器性能
```

增加轮次数会：
- 提高密码破解难度
- 增加计算资源消耗
- 增加验证时间

在项目中，我们已将轮次从8提高到12，这大幅提升了安全性。

### 2. 密码传输安全问题

使用bcrypt时面临的一个挑战是：用户密码需要以明文形式传输到服务器才能验证。为了增强安全性，可以考虑：

#### a. 确保使用HTTPS/TLS

所有包含密码的请求必须通过加密连接传输。

#### b. 添加客户端预哈希

在客户端对密码进行初步哈希处理，再传输到服务器：

```javascript
// 前端代码示例
const clientHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
// 将clientHash发送到服务器，而不是原始密码
```

```typescript
// 后端相应修改
// 注册时
const hash = await bcrypt.hash(clientHashFromRequest, salt);

// 验证时
const same = await bcrypt.compare(clientHashFromRequest, profile.password!);
```

#### 兼容现有用户数据

当引入客户端预哈希时，需要处理已有用户的兼容性问题。以下是一种平滑过渡方案：

1. **标记新旧密码哈希**

在用户表中添加一个标志字段来区分哈希类型：

```sql
ALTER TABLE user_profiles ADD COLUMN password_version INTEGER DEFAULT 0;
```

- `password_version = 0`: 原始模式（服务器端直接bcrypt）
- `password_version = 1`: 新模式（客户端SHA-256 + 服务器bcrypt）

2. **修改验证逻辑**

```typescript
async function verifyPassword(inputPassword, storedHash, passwordVersion) {
  if (passwordVersion === 0) {
    // 旧版本：直接验证明文密码
    return bcrypt.compare(inputPassword, storedHash);
  } else {
    // 新版本：验证已预哈希的密码
    const clientHash = computeClientHash(inputPassword); // 在服务器端模拟客户端哈希
    return bcrypt.compare(clientHash, storedHash);
  }
}
```

3. **登录时自动迁移**

当用户使用旧密码成功登录时，自动将其升级到新格式：

```typescript
async function handleLogin(username, password) {
  const user = await getUserByUsername(username);
  
  // 首先尝试直接验证（旧方式）
  if (user.passwordVersion === 0) {
    const isValid = await bcrypt.compare(password, user.passwordHash);
    
    if (isValid) {
      // 登录成功，升级到新密码格式
      const clientHash = computeClientHash(password);
      const salt = await bcrypt.genSalt(12);
      const newHash = await bcrypt.hash(clientHash, salt);
      
      await updateUser(user.id, {
        passwordHash: newHash,
        passwordVersion: 1
      });
      
      return generateAuthToken(user);
    }
  } else {
    // 已经是新格式，使用客户端哈希方式验证
    const clientHash = computeClientHash(password);
    const isValid = await bcrypt.compare(clientHash, user.passwordHash);
    
    if (isValid) {
      return generateAuthToken(user);
    }
  }
  
  throw new Error('Invalid credentials');
}
```

4. **前端兼容处理**

前端需要根据API响应决定是否执行客户端哈希：

```javascript
async function login(username, password) {
  // 检查是否支持新登录方式
  const { supportsClientHashing } = await checkApiVersion();
  
  let passwordToSend = password;
  
  if (supportsClientHashing) {
    // 新API版本：执行客户端预哈希
    passwordToSend = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    passwordToSend = arrayBufferToHex(passwordToSend); // 转换为十六进制字符串
  }
  
  // 发送登录请求
  return api.post('/auth/login', {
    username,
    password: passwordToSend,
    // 告诉服务器这是哪种密码格式
    passwordVersion: supportsClientHashing ? 1 : 0
  });
}
```

5. **新用户直接使用新方式**

所有新注册用户直接采用新的密码存储方式，无需迁移。

这种渐进式迁移策略可以确保：
- 现有用户仍然可以使用原有密码登录
- 成功登录后，密码会自动升级到更安全的格式
- 新用户直接使用更安全的方式
- 整个过程对用户透明，无需用户主动更改密码

#### c. 考虑使用更高级的协议

对于特别敏感的系统，可以考虑实现如SRP（Secure Remote Password）等零知识证明协议。

## 总结

bcrypt是一种强大的密码哈希解决方案，已在Misskey项目中正确实现。通过增加轮次数，我们提高了安全性，但仍需注意密码传输过程的安全保障。

最佳实践是：
1. 使用足够高的轮次数（12或更高）
2. 始终通过HTTPS传输密码
3. 考虑添加客户端预哈希作为额外安全层
4. 在服务器端尽快处理并从内存中清除密码明文 
# Misskey令牌管理机制

## 概述

Misskey使用令牌（token）机制进行用户认证，支持多种令牌类型，但与许多其他系统不同，Misskey的访问令牌（Access Token）默认**没有设置自动过期机制**。本文将详细介绍Misskey的令牌管理机制，包括生成、验证、刷新和撤销等方面。

## 令牌类型

Misskey中主要有以下几种令牌：

1. **原生用户令牌**（Native User Token）：用户账号本身的令牌
2. **访问令牌**（Access Token）：第三方应用授权使用的令牌
3. **会话令牌**（Session Token）：用于身份验证流程的临时令牌

## 令牌生成

### 访问令牌（Access Token）生成

在OAuth或MiAuth流程中，通过`auth/accept`接口生成访问令牌：

```typescript
// 生成32位安全随机字符串作为令牌
const accessToken = secureRndstr(32);

// 生成令牌散列（用于验证）
const sha256 = crypto.createHash('sha256');
sha256.update(accessToken + app.secret);
const hash = sha256.digest('hex');

// 记录当前时间
const now = new Date();

// 插入访问令牌记录
await this.accessTokensRepository.insert({
  id: this.idService.gen(now.getTime()),
  lastUsedAt: now,
  appId: session.appId,
  userId: me.id,
  token: accessToken,
  hash: hash,
});
```

## 令牌使用和验证

令牌验证主要通过`AuthenticateService.authenticate`方法实现：

```typescript
public async authenticate(token: string | null | undefined): Promise<[MiLocalUser | null, MiAccessToken | null]> {
  if (token == null) {
    return [null, null];
  }

  // 原生用户令牌验证
  if (isNativeUserToken(token)) {
    const user = await this.cacheService.localUserByNativeTokenCache.fetch(token,
      () => this.usersRepository.findOneBy({ token }) as Promise<MiLocalUser | null>);

    if (user == null) {
      throw new AuthenticationError('user not found');
    }

    return [user, null];
  } else {
    // 访问令牌验证
    const accessToken = await this.accessTokensRepository.findOne({
      where: [{
        hash: token.toLowerCase(), // app
      }, {
        token: token, // miauth
      }],
    });

    if (accessToken == null) {
      throw new AuthenticationError('invalid signature');
    }

    // 更新最后使用时间
    this.accessTokensRepository.update(accessToken.id, {
      lastUsedAt: new Date(),
    });

    // 获取用户信息
    const user = await this.cacheService.localUserByIdCache.fetch(accessToken.userId,
      () => this.usersRepository.findOneBy({
        id: accessToken.userId,
      }) as Promise<MiLocalUser>);

    return [user, accessToken];
  }
}
```

## 令牌刷新机制

**重要**：Misskey中的访问令牌**没有自动过期机制**，而是采用以下方式管理令牌：

1. **Last Used记录**：系统会记录每个令牌的最后使用时间（`lastUsedAt`字段）
   ```typescript
   this.accessTokensRepository.update(accessToken.id, {
     lastUsedAt: new Date(),
   });
   ```

2. **手动撤销**：用户可以通过`i/revoke-token`接口手动撤销访问令牌
   ```typescript
   await this.accessTokensRepository.delete({
     id: ps.tokenId,
     userId: me.id,
   });
   ```

3. **OAuth2代码模式**：在OAuth2.0授权码模式中，授权码有5分钟的过期时间，但生成的访问令牌仍然没有过期时间
   ```typescript
   const grantCodeCache = new MemoryKVCache<{
     // ... 其他字段
   }>(1000 * 60 * 5); // expires after 5m
   ```

## 与传统令牌机制的区别

与许多其他系统不同，Misskey的令牌机制有以下特点：

1. **无自动过期**：访问令牌默认不会自动过期，除非被手动撤销
2. **无刷新令牌**：不使用单独的刷新令牌（Refresh Token）来更新访问令牌
3. **活动记录**：记录令牌的最后使用时间，但不用于自动过期

这种设计的优势是简化了客户端和服务器之间的交互，不需要处理令牌过期和刷新逻辑。但也带来了安全风险，因为泄露的令牌可能会长期有效，直到被手动撤销。

## 令牌安全建议

鉴于Misskey的令牌不会自动过期，建议用户和应用开发者采取以下安全措施：

1. **定期检查活动令牌**：用户应定期审查和撤销不再使用的令牌
2. **实现客户端自动刷新**：应用开发者可以实现定期重新认证，获取新令牌
3. **监控异常访问**：监控令牌的使用情况，检测可能的异常活动

## 结论

Misskey的令牌管理机制侧重于简化和持久性，而不是严格的时间限制。这种设计适合需要长期维持用户登录状态的应用场景，但用户和开发者应了解其安全隐患，并采取适当的补充措施来保护账户安全。 
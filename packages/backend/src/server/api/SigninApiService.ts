/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 本文件使用TypeORM进行数据库操作
// 1. 通过@Inject注入TypeORM的Repository实例
// 2. 使用TypeORM的查询方法（如findOneBy）进行数据库操作
// 3. 使用TypeORM的查询操作符（如IsNull）构建查询条件

import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { IsNull } from 'typeorm';
import * as Misskey from 'misskey-js';
import { DI } from '@/di-symbols.js';
import type {
	MiMeta,
	SigninsRepository,
	UserProfilesRepository,
	UserSecurityKeysRepository,
	UsersRepository,
} from '@/models/_.js';
import type { Config } from '@/config.js';
import { getIpHash } from '@/misc/get-ip-hash.js';
import type { MiLocalUser } from '@/models/User.js';
import { IdService } from '@/core/IdService.js';
import { bindThis } from '@/decorators.js';
import { WebAuthnService } from '@/core/WebAuthnService.js';
import { UserAuthService } from '@/core/UserAuthService.js';
import { CaptchaService } from '@/core/CaptchaService.js';
import { FastifyReplyError } from '@/misc/fastify-reply-error.js';
import { RateLimiterService } from './RateLimiterService.js';
import { SigninService } from './SigninService.js';
import type { AuthenticationResponseJSON } from '@simplewebauthn/types';
import type { FastifyReply, FastifyRequest } from 'fastify';


// TODO[NestJS] 依赖注入是啥意思？
/**
 * 登录API服务
 * 处理用户登录相关的所有逻辑，包括常规密码登录、双因素认证、WebAuthn登录等
 * 这是NestJS框架的依赖注入服务，用于处理登录相关的业务逻辑
 */
@Injectable()
export class SigninApiService {
	constructor(
		@Inject(DI.config)
		private config: Config, // 应用配置

		@Inject(DI.meta)
		private meta: MiMeta, // 元数据设置

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository, // 用户存储库，使用TypeORM的Repository模式进行数据库操作

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository, // 用户资料存储库

		@Inject(DI.userSecurityKeysRepository)
		private userSecurityKeysRepository: UserSecurityKeysRepository, // 用户安全密钥存储库

		@Inject(DI.signinsRepository)
		private signinsRepository: SigninsRepository, // 登录记录存储库

		private idService: IdService, // ID生成服务
		private rateLimiterService: RateLimiterService, // 速率限制服务
		private signinService: SigninService, // 登录服务
		private userAuthService: UserAuthService, // 用户认证服务
		private webAuthnService: WebAuthnService, // WebAuthn服务
		private captchaService: CaptchaService, // 验证码服务
	) {
	}

	// TODO[JS] await 是啥意思？ 具体怎么使用的？
	/**
	 * 处理用户登录请求
	 * @param request 包含用户名、密码、令牌等登录信息的请求
	 * @param reply 响应对象
	 * @returns 登录结果或下一步登录流程信息
	 * async：表示这是一个异步方法，可以在方法内使用await关键字
	 */
	@bindThis
	public async signin(
		request: FastifyRequest<{
			Body: {
				username: string; // 用户名
				password?: string; // 密码（可选）
				token?: string; // 双因素认证令牌（可选）
				credential?: AuthenticationResponseJSON; // WebAuthn认证响应（可选）
				'hcaptcha-response'?: string; // hCaptcha响应（可选）
				'g-recaptcha-response'?: string; // Google reCAPTCHA响应（可选）
				'turnstile-response'?: string; // Cloudflare Turnstile响应（可选）
				'm-captcha-response'?: string; // mCaptcha响应（可选）
				'testcaptcha-response'?: string; // 测试验证码响应（可选）
			};
		}>,
		reply: FastifyReply,
	) {
		// 设置CORS头，允许来自应用URL的跨域请求
		reply.header('Access-Control-Allow-Origin', this.config.url);
		reply.header('Access-Control-Allow-Credentials', 'true');

		const body = request.body;
		const username = body['username'];
		const password = body['password'];
		const token = body['token'];

		/**
		 * 生成错误响应
		 * @param status HTTP状态码
		 * @param error 错误信息对象
		 * @returns 格式化的错误响应
		 */
		function error(status: number, error: { id: string }) {
			reply.code(status);
			return { error };
		}

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

		// 验证用户名是否为字符串
		if (typeof username !== 'string') {
			reply.code(400);
			return;
		}

		// 验证令牌是否为字符串（如果存在）
		if (token != null && typeof token !== 'string') {
			reply.code(400);
			return;
		}

		// 根据用户名查找本地用户
		// findOneBy是TypeORM提供的方法，用于在数据库中查找符合条件的单个记录
		// 它接受一个条件对象，用于指定查询条件
		// 这里查询条件是：usernameLower等于小写的用户名，且host为null（表示本地用户）
		// IsNull()是TypeORM提供的查询操作符，用于检查字段是否为null
		// TODO[JS] 哪里看出来是使用的TypeORM？ 感觉封装了不少东西，慢慢去深究吧
		const user = await this.usersRepository.findOneBy({
			usernameLower: username.toLowerCase(),
			host: IsNull(),
		}) as MiLocalUser; // 使用TypeORM的类型系统进行类型断言

		// 如果用户不存在，返回404错误
		if (user == null) {
			return error(404, {
				id: '6cc579cc-885d-43d8-95c2-b8c7fc963280',
			});
		}

		// 如果用户被暂停，返回403错误
		if (user.isSuspended) {
			return error(403, {
				id: 'e03a5f46-d309-4865-9b69-56282d94e1eb',
			});
		}

		// 获取用户资料
		const profile = await this.userProfilesRepository.findOneByOrFail({ userId: user.id });
		// TODO[here] 5.12 
		// 检查用户是否有安全密钥
		const securityKeysAvailable = await this.userSecurityKeysRepository.countBy({ userId: user.id }).then(result => result >= 1);

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
			}
		}

		// 验证密码是否为字符串
		if (typeof password !== 'string') {
			reply.code(400);
			return;
		}

		// 比较提供的密码与存储的密码哈希
		const same = await bcrypt.compare(password, profile.password!);

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

		// 没有启用双因素认证的情况处理
		if (!profile.twoFactorEnabled) {
			// 在非测试环境下验证验证码
			if (process.env.NODE_ENV !== 'test') {
				// 验证hCaptcha
				if (this.meta.enableHcaptcha && this.meta.hcaptchaSecretKey) {
					await this.captchaService.verifyHcaptcha(this.meta.hcaptchaSecretKey, body['hcaptcha-response']).catch(err => {
						throw new FastifyReplyError(400, err);
					});
				}

				// 验证mCaptcha
				if (this.meta.enableMcaptcha && this.meta.mcaptchaSecretKey && this.meta.mcaptchaSitekey && this.meta.mcaptchaInstanceUrl) {
					await this.captchaService.verifyMcaptcha(this.meta.mcaptchaSecretKey, this.meta.mcaptchaSitekey, this.meta.mcaptchaInstanceUrl, body['m-captcha-response']).catch(err => {
						throw new FastifyReplyError(400, err);
					});
				}

				// 验证reCAPTCHA
				if (this.meta.enableRecaptcha && this.meta.recaptchaSecretKey) {
					await this.captchaService.verifyRecaptcha(this.meta.recaptchaSecretKey, body['g-recaptcha-response']).catch(err => {
						throw new FastifyReplyError(400, err);
					});
				}

				// 验证Turnstile
				if (this.meta.enableTurnstile && this.meta.turnstileSecretKey) {
					await this.captchaService.verifyTurnstile(this.meta.turnstileSecretKey, body['turnstile-response']).catch(err => {
						throw new FastifyReplyError(400, err);
					});
				}

				// 验证测试验证码
				if (this.meta.enableTestcaptcha) {
					await this.captchaService.verifyTestcaptcha(body['testcaptcha-response']).catch(err => {
						throw new FastifyReplyError(400, err);
					});
				}
			}

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
		} else if (body.credential) {
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
		} else if (securityKeysAvailable) {
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
		} else {
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
		// 永远不会执行到这里
	}
}

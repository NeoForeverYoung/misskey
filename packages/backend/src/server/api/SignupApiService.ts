/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { RegistrationTicketsRepository, UsedUsernamesRepository, UserPendingsRepository, UserProfilesRepository, UsersRepository, MiRegistrationTicket, MiMeta } from '@/models/_.js';
import type { Config } from '@/config.js';
import { CaptchaService } from '@/core/CaptchaService.js';
import { IdService } from '@/core/IdService.js';
import { SignupService } from '@/core/SignupService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { EmailService } from '@/core/EmailService.js';
import { MiLocalUser } from '@/models/User.js';
import { FastifyReplyError } from '@/misc/fastify-reply-error.js';
import { bindThis } from '@/decorators.js';
import { L_CHARS, secureRndstr } from '@/misc/secure-rndstr.js';
import { SigninService } from './SigninService.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * 注册API服务
 * 
 * 负责处理用户注册相关的HTTP请求，包括：
 * 1. 普通注册
 * 2. 邀请码注册
 * 3. 需要邮箱验证的注册
 * 4. 完成注册待验证流程
 */
@Injectable()
export class SignupApiService {
	constructor(
		/**
		 * 注入应用配置
		 */
		@Inject(DI.config)
		private config: Config,

		/**
		 * 注入元数据，包含各种系统设置
		 */
		@Inject(DI.meta)
		private meta: MiMeta,

		/**
		 * 注入用户仓库，用于用户查询和操作
		 */
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		/**
		 * 注入用户个人资料仓库
		 */
		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		/**
		 * 注入用户待验证信息仓库，存储等待邮箱验证的用户信息
		 */
		@Inject(DI.userPendingsRepository)
		private userPendingsRepository: UserPendingsRepository,

		/**
		 * 注入已使用用户名仓库，用于检查用户名是否可用
		 */
		@Inject(DI.usedUsernamesRepository)
		private usedUsernamesRepository: UsedUsernamesRepository,

		/**
		 * 注入注册票据仓库，用于邀请码功能
		 */
		@Inject(DI.registrationTicketsRepository)
		private registrationTicketsRepository: RegistrationTicketsRepository,

		/**
		 * 用户实体服务，用于打包用户信息
		 */
		private userEntityService: UserEntityService,
		
		/**
		 * ID生成服务，用于生成唯一ID
		 */
		private idService: IdService,
		
		/**
		 * 验证码服务，用于验证各种验证码
		 */
		private captchaService: CaptchaService,
		
		/**
		 * 注册核心服务，处理实际的注册逻辑
		 */
		private signupService: SignupService,
		
		/**
		 * 登录服务，用于注册后自动登录
		 */
		private signinService: SigninService,
		
		/**
		 * 邮件服务，用于发送验证邮件
		 */
		private emailService: EmailService,
	) {
	}

	/**
	 * 处理用户注册请求
	 * 
	 * @param request 包含注册信息的请求对象
	 * @param reply 响应对象
	 * @returns 如果成功，返回用户信息和token；如果是邮箱验证流程，返回204状态码
	 */
	@bindThis
	public async signup(
		request: FastifyRequest<{
			Body: {
				username: string;        // 用户名
				password: string;        // 密码
				host?: string;           // 主机（仅测试环境使用）
				invitationCode?: string; // 邀请码
				emailAddress?: string;   // 电子邮件地址
				'hcaptcha-response'?: string;     // hCaptcha响应
				'g-recaptcha-response'?: string;  // Google reCAPTCHA响应
				'turnstile-response'?: string;    // Cloudflare Turnstile响应
				'm-captcha-response'?: string;    // mCaptcha响应
				'testcaptcha-response'?: string;  // 测试验证码响应
			}
		}>,
		reply: FastifyReply,
	) {
		const body = request.body;

		// 验证各种验证码，但在测试环境中跳过
		// 这些验证码用于防止自动化注册和滥用
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

			// 验证Google reCAPTCHA
			if (this.meta.enableRecaptcha && this.meta.recaptchaSecretKey) {
				await this.captchaService.verifyRecaptcha(this.meta.recaptchaSecretKey, body['g-recaptcha-response']).catch(err => {
					throw new FastifyReplyError(400, err);
				});
			}

			// 验证Cloudflare Turnstile
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

		// 提取请求参数
		const username = body['username'];
		const password = body['password'];
		const host: string | null = process.env.NODE_ENV === 'test' ? (body['host'] ?? null) : null; // 仅在测试环境中使用host参数
		const invitationCode = body['invitationCode'];
		const emailAddress = body['emailAddress'];

		// 如果系统要求电子邮件用于注册，但未提供有效邮箱，则返回400错误
		if (this.meta.emailRequiredForSignup) {
			if (emailAddress == null || typeof emailAddress !== 'string') {
				reply.code(400);
				return;
			}

			// 验证邮箱格式和可用性
			const res = await this.emailService.validateEmailForAccount(emailAddress);
			if (!res.available) {
				reply.code(400);
				return;
			}
		}

		let ticket: MiRegistrationTicket | null = null;

		// 如果系统禁用了开放注册，则需要邀请码
		if (this.meta.disableRegistration) {
			if (invitationCode == null || typeof invitationCode !== 'string') {
				reply.code(400);
				return;
			}

			// 查找邀请码
			ticket = await this.registrationTicketsRepository.findOneBy({
				code: invitationCode,
			});

			// 验证邀请码的有效性
			if (ticket == null || ticket.usedById != null) {
				// 邀请码不存在或已被使用
				reply.code(400);
				return;
			}

			// 检查邀请码是否过期
			if (ticket.expiresAt && ticket.expiresAt < new Date()) {
				reply.code(400);
				return;
			}

			// 如果系统要求电子邮件验证
			if (this.meta.emailRequiredForSignup) {
				// 如果邀请码已经被某个用户使用，返回错误
				if (ticket.usedBy) {
					reply.code(400);
					return;
				}

				// 如果邀请码在30分钟内已被用于发送验证邮件，则返回错误（防止重复发送）
				if (ticket.usedAt && ticket.usedAt.getTime() + (1000 * 60 * 30) > Date.now()) {
					reply.code(400);
					return;
				}
			} else if (ticket.usedAt) {
				// 如果不需要邮件验证，但邀请码已被使用，返回错误
				reply.code(400);
				return;
			}
		}

		// 如果系统要求邮箱验证，执行邮箱验证流程
		if (this.meta.emailRequiredForSignup) {
			// 检查用户名是否已存在
			if (await this.usersRepository.exists({ where: { usernameLower: username.toLowerCase(), host: IsNull() } })) {
				throw new FastifyReplyError(400, 'DUPLICATED_USERNAME');
			}

			// 检查用户名是否曾经被使用过（包括已删除的用户）
			if (await this.usedUsernamesRepository.exists({ where: { username: username.toLowerCase() } })) {
				throw new FastifyReplyError(400, 'USED_USERNAME');
			}

			// 检查用户名是否为系统保留用户名
			const isPreserved = this.meta.preservedUsernames.map(x => x.toLowerCase()).includes(username.toLowerCase());
			if (isPreserved) {
				throw new FastifyReplyError(400, 'DENIED_USERNAME');
			}

			// 生成验证码
			const code = secureRndstr(16, { chars: L_CHARS });

			// 生成密码哈希
			const salt = await bcrypt.genSalt(8);
			const hash = await bcrypt.hash(password, salt);

			// 创建待验证用户记录
			const pendingUser = await this.userPendingsRepository.insertOne({
				id: this.idService.gen(),
				code,
				email: emailAddress!,
				username: username,
				password: hash,
			});

			// 构建验证链接
			const link = `${this.config.url}/signup-complete/${code}`;

			// 发送验证邮件
			this.emailService.sendEmail(emailAddress!, 'Signup',
				`To complete signup, please click this link:<br><a href="${link}">${link}</a>`,
				`To complete signup, please click this link: ${link}`);

			// 如果使用了邀请码，更新邀请码状态
			if (ticket) {
				await this.registrationTicketsRepository.update(ticket.id, {
					usedAt: new Date(),
					pendingUserId: pendingUser.id,
				});
			}

			// 返回204状态码，表示请求成功但没有内容返回
			reply.code(204);
			return;
		} else {
			// 如果不需要邮箱验证，直接完成注册
			try {
				// 调用注册服务创建账号
				const { account, secret } = await this.signupService.signup({
					username, password, host,
				});

				// 打包用户信息，包括私密信息
				const res = await this.userEntityService.pack(account, account, {
					schema: 'MeDetailed',
					includeSecrets: true,
				});

				// 如果使用了邀请码，更新邀请码状态
				if (ticket) {
					await this.registrationTicketsRepository.update(ticket.id, {
						usedAt: new Date(),
						usedBy: account,
						usedById: account.id,
					});
				}

				// 返回用户信息和身份令牌
				return {
					...res,
					token: secret,
				};
			} catch (err) {
				// 注册过程中发生错误
				throw new FastifyReplyError(400, typeof err === 'string' ? err : (err as Error).toString());
			}
		}
	}

	/**
	 * 处理通过邮箱验证完成注册的请求
	 * 
	 * @param request 包含验证码的请求
	 * @param reply 响应对象
	 * @returns 登录后的用户信息
	 */
	@bindThis
	public async signupPending(request: FastifyRequest<{ Body: { code: string; } }>, reply: FastifyReply) {
		const body = request.body;

		// 获取验证码
		const code = body['code'];

		try {
			// 查找对应的待验证用户
			const pendingUser = await this.userPendingsRepository.findOneByOrFail({ code });

			// 检查验证码是否过期（30分钟内有效）
			if (this.idService.parse(pendingUser.id).date.getTime() + (1000 * 60 * 30) < Date.now()) {
				throw new FastifyReplyError(400, 'EXPIRED');
			}

			// 调用注册服务创建账号，使用之前保存的密码哈希
			const { account, secret } = await this.signupService.signup({
				username: pendingUser.username,
				passwordHash: pendingUser.password,
			});

			// 删除待验证用户记录
			this.userPendingsRepository.delete({
				id: pendingUser.id,
			});

			// 获取用户资料
			const profile = await this.userProfilesRepository.findOneByOrFail({ userId: account.id });

			// 更新用户邮箱信息，标记为已验证
			await this.userProfilesRepository.update({ userId: profile.userId }, {
				email: pendingUser.email,
				emailVerified: true,
				emailVerifyCode: null,
			});

			// 更新邀请码状态（如果有）
			const ticket = await this.registrationTicketsRepository.findOneBy({ pendingUserId: pendingUser.id });
			if (ticket) {
				await this.registrationTicketsRepository.update(ticket.id, {
					usedBy: account,
					usedById: account.id,
					pendingUserId: null,
				});
			}

			// 完成注册后自动登录
			return this.signinService.signin(request, reply, account as MiLocalUser);
		} catch (err) {
			// 处理过程中发生错误
			throw new FastifyReplyError(400, typeof err === 'string' ? err : (err as Error).toString());
		}
	}
}

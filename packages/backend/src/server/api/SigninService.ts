/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Misskey from 'misskey-js';
import { DI } from '@/di-symbols.js';
import type { SigninsRepository, UserProfilesRepository } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import type { MiLocalUser } from '@/models/User.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { SigninEntityService } from '@/core/entities/SigninEntityService.js';
import { bindThis } from '@/decorators.js';
import { EmailService } from '@/core/EmailService.js';
import { NotificationService } from '@/core/NotificationService.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * 登录服务
 * 
 * 该服务负责在用户成功通过身份验证后处理登录过程的最后阶段
 * 与SigninApiService不同，SigninApiService处理验证过程(密码检查、2FA等)
 * 而SigninService处理验证成功后的操作(记录登录、发送通知等)
 */
@Injectable()
export class SigninService {
	constructor(
		// 注入登录记录存储库，用于保存用户登录历史
		@Inject(DI.signinsRepository)
		private signinsRepository: SigninsRepository,

		// 注入用户资料存储库，用于获取用户邮箱等信息
		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		// 登录实体服务，用于格式化登录记录
		private signinEntityService: SigninEntityService,
		// 邮件服务，用于发送登录通知邮件
		private emailService: EmailService,
		// 通知服务，用于创建系统内部通知
		private notificationService: NotificationService,
		// ID生成服务，用于生成唯一标识符
		private idService: IdService,
		// 全局事件服务，用于发布事件到用户的流
		private globalEventService: GlobalEventService,
	) {
	}

	/**
	 * 处理用户成功登录
	 * 
	 * 该方法在用户通过所有身份验证步骤后被调用
	 * 它执行以下操作:
	 * 1. 创建登录通知
	 * 2. 记录成功的登录尝试
	 * 3. 发布登录事件到用户的主流
	 * 4. 发送登录通知邮件(如果用户有验证过的邮箱)
	 * 5. 返回登录成功响应(包含用户ID和访问令牌)
	 * 
	 * @param request Fastify请求对象，包含IP和头信息
	 * @param reply Fastify响应对象，用于设置状态码
	 * @param user 已验证的本地用户
	 * @returns 登录流程响应，标记为已完成
	 */
	@bindThis
	public signin(request: FastifyRequest, reply: FastifyReply, user: MiLocalUser) {
		// 使用setImmediate将后续操作放入事件循环，不阻塞响应返回
		// TODO[JS] 使用await和async 与setImmediate有什么区别？
		setImmediate(async () => {
			// 创建登录通知，显示在用户的通知中心
			this.notificationService.createNotification(user.id, 'login', {});

			// 记录成功的登录尝试，包含IP和请求头信息(用于安全审计)
			const record = await this.signinsRepository.insertOne({
				id: this.idService.gen(),
				userId: user.id,
				ip: request.ip,
				headers: request.headers as any,
				success: true,
			});

			// 发布登录事件到用户的主流，前端可以接收此事件并更新UI
			this.globalEventService.publishMainStream(user.id, 'signin', await this.signinEntityService.pack(record));

			// 如果用户有验证过的邮箱，发送登录通知邮件
			const profile = await this.userProfilesRepository.findOneByOrFail({ userId: user.id });
			if (profile.email && profile.emailVerified) {
				this.emailService.sendEmail(profile.email, 'New login / ログインがありました',
					'There is a new login. If you do not recognize this login, update the security status of your account, including changing your password. / 新しいログインがありました。このログインに心当たりがない場合は、パスワードを変更するなど、アカウントのセキュリティ状態を更新してください。',
					'There is a new login. If you do not recognize this login, update the security status of your account, including changing your password. / 新しいログインがありました。このログインに心当たりがない場合は、パスワードを変更するなど、アカウントのセキュリティ状態を更新してください。');
			}
		});

		// 设置成功状态码
		reply.code(200);
		// 返回登录成功响应，包含用户ID和访问令牌
		return {
			finished: true,
			id: user.id,
			i: user.token!, // 用户访问令牌，用于后续API调用的身份验证
		} satisfies Misskey.entities.SigninFlowResponse;
	}
}


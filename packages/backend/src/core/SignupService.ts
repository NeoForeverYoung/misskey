/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { generateKeyPair } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { DataSource, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { MiMeta, UsedUsernamesRepository, UsersRepository } from '@/models/_.js';
import { MiUser } from '@/models/User.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { IdService } from '@/core/IdService.js';
import { MiUserKeypair } from '@/models/UserKeypair.js';
import { MiUsedUsername } from '@/models/UsedUsername.js';
import { generateNativeUserToken } from '@/misc/token.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { bindThis } from '@/decorators.js';
import UsersChart from '@/core/chart/charts/users.js';
import { UtilityService } from '@/core/UtilityService.js';
import { UserService } from '@/core/UserService.js';
import { SystemAccountService } from '@/core/SystemAccountService.js';
import { MetaService } from '@/core/MetaService.js';

/**
 * 用户注册核心服务
 * 
 * 该服务负责处理用户注册的核心逻辑，包括：
 * 1. 验证用户名和密码
 * 2. 创建用户账号及相关数据
 * 3. 生成RSA密钥对（用于ActivityPub联邦身份验证）
 * 4. 处理特殊账号（如根账号）的情况
 */
@Injectable()
export class SignupService {
	constructor(
		/**
		 * 数据库连接
		 */
		@Inject(DI.db)
		private db: DataSource,

		/**
		 * 元数据，包含系统设置
		 */
		@Inject(DI.meta)
		private meta: MiMeta,

		/**
		 * 用户仓库
		 */
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		/**
		 * 已使用用户名仓库，记录所有曾经使用过的用户名（包括已删除账号的）
		 */
		@Inject(DI.usedUsernamesRepository)
		private usedUsernamesRepository: UsedUsernamesRepository,

		/**
		 * 工具服务，提供各种辅助功能
		 */
		private utilityService: UtilityService,
		
		/**
		 * 用户服务，处理用户相关操作
		 */
		private userService: UserService,
		
		/**
		 * 用户实体服务，处理用户验证和实体转换
		 */
		private userEntityService: UserEntityService,
		
		/**
		 * ID生成服务
		 */
		private idService: IdService,
		
		/**
		 * 系统账号服务
		 */
		private systemAccountService: SystemAccountService,
		
		/**
		 * 元数据服务，用于更新系统设置
		 */
		private metaService: MetaService,
		
		/**
		 * 用户统计图表服务
		 */
		private usersChart: UsersChart,
	) {
	}

	/**
	 * 创建新用户
	 * 
	 * @param opts 注册选项
	 * @param opts.username 用户名
	 * @param opts.password 密码（与passwordHash二选一）
	 * @param opts.passwordHash 已哈希的密码（与password二选一）
	 * @param opts.host 主机名（联邦实例用户）
	 * @param opts.ignorePreservedUsernames 是否忽略保留用户名检查
	 * @returns 创建的用户账号和用户令牌
	 */
	@bindThis
	public async signup(opts: {
		username: MiUser['username'];
		password?: string | null;
		passwordHash?: MiUserProfile['password'] | null;
		host?: string | null;
		ignorePreservedUsernames?: boolean;
	}) {
		const { username, password, passwordHash, host } = opts;
		let hash = passwordHash;

		// 验证用户名格式
		if (!this.userEntityService.validateLocalUsername(username)) {
			throw new Error('INVALID_USERNAME');
		}

		// 如果提供了明文密码，验证并哈希处理
		if (password != null && passwordHash == null) {
			// 验证密码强度
			if (!this.userEntityService.validatePassword(password)) {
				throw new Error('INVALID_PASSWORD');
			}

			// 生成密码哈希
			const salt = await bcrypt.genSalt(8);
			hash = await bcrypt.hash(password, salt);
		}

		// 生成用户认证令牌
		const secret = generateNativeUserToken();

		// 检查用户名是否已存在
		if (await this.usersRepository.exists({ where: { usernameLower: username.toLowerCase(), host: IsNull() } })) {
			throw new Error('DUPLICATED_USERNAME');
		}

		// 检查用户名是否被曾经使用过（包括已删除的账号）
		if (await this.usedUsernamesRepository.exists({ where: { username: username.toLowerCase() } })) {
			throw new Error('USED_USERNAME');
		}

		// 检查是否为系统保留用户名（除非明确忽略此检查）
		if (!opts.ignorePreservedUsernames && this.meta.rootUserId != null) {
			const isPreserved = this.meta.preservedUsernames.map(x => x.toLowerCase()).includes(username.toLowerCase());
			if (isPreserved) {
				throw new Error('USED_USERNAME');
			}
		}

		// 生成RSA密钥对，用于ActivityPub联邦身份验证
		// TODO[ActivityPub]: 使用Ed25519密钥对
		const keyPair = await new Promise<string[]>((res, rej) =>
			generateKeyPair('rsa', {
				modulusLength: 2048,
				publicKeyEncoding: {
					type: 'spki',
					format: 'pem',
				},
				privateKeyEncoding: {
					type: 'pkcs8',
					format: 'pem',
					cipher: undefined,
					passphrase: undefined,
				},
			}, (err, publicKey, privateKey) =>
				err ? rej(err) : res([publicKey, privateKey]),
			));

		let account!: MiUser;

		// 开始事务，确保所有相关数据的原子性创建
		await this.db.transaction(async transactionalEntityManager => {
			// 再次检查用户名，防止并发注册导致的冲突
			const exist = await transactionalEntityManager.findOneBy(MiUser, {
				usernameLower: username.toLowerCase(),
				host: IsNull(),
			});

			if (exist) throw new Error(' the username is already used');

			// 创建用户主记录
			account = await transactionalEntityManager.save(new MiUser({
				id: this.idService.gen(), // 生成唯一ID
				username: username,
				usernameLower: username.toLowerCase(), // 存储小写用户名用于不区分大小写的查询
				host: this.utilityService.toPunyNullable(host), // 将Unicode域名转换为Punycode（用于联邦实例）
				token: secret, // 身份验证令牌
			}));

			// 保存用户密钥对
			await transactionalEntityManager.save(new MiUserKeypair({
				publicKey: keyPair[0],
				privateKey: keyPair[1],
				userId: account.id,
			}));

			// 保存用户个人资料
			await transactionalEntityManager.save(new MiUserProfile({
				userId: account.id,
				autoAcceptFollowed: true, // 默认自动接受关注请求
				password: hash, // 密码哈希
			}));

			// 记录已使用的用户名
			await transactionalEntityManager.save(new MiUsedUsername({
				createdAt: new Date(),
				username: username.toLowerCase(),
			}));
		});

		// 更新用户统计
		this.usersChart.update(account, true);
		
		// 触发系统Webhook通知
		this.userService.notifySystemWebhook(account, 'userCreated');

		// 如果这是第一个用户，将其设为根用户（管理员）
		if (this.meta.rootUserId == null) {
			await this.metaService.update({ rootUserId: account.id });
		}

		// 返回创建的账号和身份令牌
		return { account, secret };
	}
}


/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 导入 Node.js 集群模块，用于多进程管理
import cluster from 'node:cluster';
// 导入 Node.js 文件系统模块
import * as fs from 'node:fs';
// 导入 URL 转换为文件路径的工具
import { fileURLToPath } from 'node:url';
// 导入 NestJS 依赖注入和生命周期钩子
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
// 导入 Fastify 框架和它的实例类型
import Fastify, { FastifyInstance } from 'fastify';
// 导入 Fastify 静态文件服务插件
import fastifyStatic from '@fastify/static';
// 导入原始请求体解析插件，用于 ActivityPub HTTP 签名验证
import fastifyRawBody from 'fastify-raw-body';
// 导入 TypeORM 查询条件 IsNull
import { IsNull } from 'typeorm';
// 导入全局事件服务
import { GlobalEventService } from '@/core/GlobalEventService.js';
// 导入配置类型
import type { Config } from '@/config.js';
// 导入数据库仓库和元数据类型
import type { EmojisRepository, MiMeta, UserProfilesRepository, UsersRepository } from '@/models/_.js';
// 导入依赖注入符号
import { DI } from '@/di-symbols.js';
// 导入日志类型
import type Logger from '@/logger.js';
// 导入账户工具
import * as Acct from '@/misc/acct.js';
// 导入身份图标生成工具
import { genIdenticon } from '@/misc/gen-identicon.js';
// 导入用户实体服务
import { UserEntityService } from '@/core/entities/UserEntityService.js';
// 导入日志服务
import { LoggerService } from '@/core/LoggerService.js';
// 导入方法绑定装饰器
import { bindThis } from '@/decorators.js';
// 导入各种服务组件
import { ActivityPubServerService } from './ActivityPubServerService.js';
import { NodeinfoServerService } from './NodeinfoServerService.js';
import { ApiServerService } from './api/ApiServerService.js';
import { StreamingApiServerService } from './api/StreamingApiServerService.js';
import { WellKnownServerService } from './WellKnownServerService.js';
import { FileServerService } from './FileServerService.js';
import { HealthServerService } from './HealthServerService.js';
import { ClientServerService } from './web/ClientServerService.js';
import { OpenApiServerService } from './api/openapi/OpenApiServerService.js';
import { OAuth2ProviderService } from './oauth/OAuth2ProviderService.js';

// 获取当前文件所在目录的路径
const _dirname = fileURLToPath(new URL('.', import.meta.url));

// 标记为可注入的服务，并实现应用关闭接口
@Injectable()
export class ServerService implements OnApplicationShutdown {
	// 日志记录器
	private logger: Logger;
	// Fastify 实例，使用私有字段
	#fastify: FastifyInstance;

	// 构造函数，通过依赖注入接收所需的服务和资源
	constructor(
		// 注入配置
		@Inject(DI.config)
		private config: Config,

		// 注入元数据
		@Inject(DI.meta)
		private meta: MiMeta,

		// 注入用户仓库
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		// 注入用户配置仓库
		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		// 注入表情符号仓库
		@Inject(DI.emojisRepository)
		private emojisRepository: EmojisRepository,

		// 其他服务的依赖注入
		private userEntityService: UserEntityService,
		private apiServerService: ApiServerService,
		private openApiServerService: OpenApiServerService,
		private streamingApiServerService: StreamingApiServerService,
		private activityPubServerService: ActivityPubServerService,
		private wellKnownServerService: WellKnownServerService,
		private nodeinfoServerService: NodeinfoServerService,
		private fileServerService: FileServerService,
		private healthServerService: HealthServerService,
		private clientServerService: ClientServerService,
		private globalEventService: GlobalEventService,
		private loggerService: LoggerService,
		private oauth2ProviderService: OAuth2ProviderService,
	) {
		// 初始化日志记录器
		this.logger = this.loggerService.getLogger('server', 'gray');
	}

	// 绑定this上下文并启动服务器
	@bindThis
	public async launch(): Promise<void> {
		// 创建 Fastify 实例，配置信任代理并禁用默认日志
		const fastify = Fastify({
			trustProxy: true,
			logger: false,
		});
		this.#fastify = fastify;

		// 设置 HTTP 严格传输安全（HSTS）
		// 有效期为6个月（15552000秒）
		if (this.config.url.startsWith('https') && !this.config.disableHsts) {
			fastify.addHook('onRequest', (request, reply, done) => {
				reply.header('strict-transport-security', 'max-age=15552000; preload');
				done();
			});
		}

		// 注册原始请求体解析器，用于 ActivityPub HTTP 签名验证
		await fastify.register(fastifyRawBody, {
			global: false,
			encoding: null,
			runFirst: true,
		});

		// 注册非服务静态服务器，使子服务可以使用 reply.sendFile
		// 这里的 `root` 只是一个占位符，每次调用必须使用自己的 `rootPath`
		fastify.register(fastifyStatic, {
			root: _dirname,
			serve: false,
		});

		// 如果请求看起来是执行 ActivityPub 对象查找，拒绝所有外部重定向
		//
		// 这会破坏涉及从第三方服务器复制 URL 的查找，比如尝试查找 http://charlie.example.com/@alice@alice.com
		//
		// 这不是标准要求，但保护我们免受未验证最终 URL 的对等节点的影响
		if (this.config.disallowExternalApRedirect) {
			// 匹配可能的 ActivityPub 查找请求的正则表达式
			const maybeApLookupRegex = /application\/activity\+json|application\/ld\+json.+activitystreams/i;
			// 添加响应发送前的钩子
			fastify.addHook('onSend', (request, reply, _, done) => {
				// 获取响应中的 location 头
				const location = reply.getHeader('location');
				// 如果不是重定向状态码或 location 不是字符串，直接通过
				if (reply.statusCode < 300 || reply.statusCode >= 400 || typeof location !== 'string') {
					done();
					return;
				}

				// 如果 Accept 头不匹配 ActivityPub 格式，直接通过
				if (!maybeApLookupRegex.test(request.headers.accept ?? '')) {
					done();
					return;
				}

				// 处理有效的 location（在非生产环境将 http 替换为 https）
				const effectiveLocation = process.env.NODE_ENV === 'production' ? location : location.replace(/^http:\/\//, 'https://');
				// 如果重定向到当前主机的 URL，允许通过
				if (effectiveLocation.startsWith(`https://${this.config.host}/`)) {
					done();
					return;
				}

				// 否则拒绝重定向，返回 406 状态码
				reply.status(406);
				reply.removeHeader('location');
				reply.header('content-type', 'text/plain; charset=utf-8');
				reply.header('link', `<${encodeURI(location)}>; rel="canonical"`);
				// 返回错误信息
				done(null, [
					"Refusing to relay remote ActivityPub object lookup.",
					"",
					`Please remove 'application/activity+json' and 'application/ld+json' from the Accept header or fetch using the authoritative URL at ${location}.`,
				].join('\n'));
			});
		}

		// 注册各种服务路由
		// 注册 API 服务(包含登录、注册、notes 等 API 端点）
		fastify.register(this.apiServerService.createServer, { prefix: '/api' });
		// 注册 OpenAPI 服务
		fastify.register(this.openApiServerService.createServer);
		// 注册文件服务
		fastify.register(this.fileServerService.createServer);
		// 注册 ActivityPub 服务
		fastify.register(this.activityPubServerService.createServer);
		// 注册 Nodeinfo 服务
		fastify.register(this.nodeinfoServerService.createServer);
		// 注册 Well-Known 服务
		fastify.register(this.wellKnownServerService.createServer);
		// 注册 OAuth2 服务和令牌服务
		fastify.register(this.oauth2ProviderService.createServer, { prefix: '/oauth' });
		fastify.register(this.oauth2ProviderService.createTokenServer, { prefix: '/oauth/token' });
		// 注册健康检查服务
		fastify.register(this.healthServerService.createServer, { prefix: '/healthz' });

		// 表情符号处理路由
		fastify.get<{ Params: { path: string }; Querystring: { static?: any; badge?: any; }; }>('/emoji/:path(.*)', async (request, reply) => {
			const path = request.params.path;

			// 设置缓存控制头（24小时）
			reply.header('Cache-Control', 'public, max-age=86400');

			// 验证路径格式，必须是字母数字、连字符、下划线、@、点组成，以 .webp 结尾
			if (!path.match(/^[a-zA-Z0-9\-_@\.]+?\.webp$/)) {
				reply.code(404);
				return;
			}

			// 处理路径，移除 .webp 后缀
			const emojiPath = path.replace(/\.webp$/i, '');
			// 按 @ 分割路径
			const pathChunks = emojiPath.split('@');

			// 如果路径部分超过2个，返回400错误
			if (pathChunks.length > 2) {
				reply.code(400);
				return;
			}

			// 获取表情符号名称和主机
			const name = pathChunks.shift();
			const host = pathChunks.pop();

			// 查找表情符号
			const emoji = await this.emojisRepository.findOneBy({
				// `@.` 是 ReactionService.decodeReaction 的规范
				host: (host === undefined || host === '.') ? IsNull() : host,
				name: name,
			});

			// 设置内容安全策略头
			reply.header('Content-Security-Policy', 'default-src \'none\'; style-src \'unsafe-inline\'');

			// 如果表情符号不存在
			if (emoji == null) {
				if ('fallback' in request.query) {
					// 如果请求中有 fallback 参数，重定向到默认表情符号
					return await reply.redirect('/static-assets/emoji-unknown.png');
				} else {
					// 否则返回404错误
					reply.code(404);
					return;
				}
			}

			// 构建表情符号 URL
			let url: URL;
			if ('badge' in request.query) {
				// 如果请求中有 badge 参数，使用 PNG 格式
				url = new URL(`${this.config.mediaProxy}/emoji.png`);
				// 使用 publicUrl 或 originalUrl（为了后向兼容性）
				url.searchParams.set('url', emoji.publicUrl || emoji.originalUrl);
				url.searchParams.set('badge', '1');
			} else {
				// 否则使用 WebP 格式
				url = new URL(`${this.config.mediaProxy}/emoji.webp`);
				// 使用 publicUrl 或 originalUrl（为了后向兼容性）
				url.searchParams.set('url', emoji.publicUrl || emoji.originalUrl);
				url.searchParams.set('emoji', '1');
				// 如果请求中有 static 参数，添加到 URL 参数中
				if ('static' in request.query) url.searchParams.set('static', '1');
			}

			// 重定向到表情符号 URL（301 永久重定向）
			return await reply.redirect(
				url.toString(),
				301,
			);
		});

		// 头像处理路由
		fastify.get<{ Params: { acct: string } }>('/avatar/@:acct', async (request, reply) => {
			// 解析账户字符串（用户名@主机）
			const { username, host } = Acct.parse(request.params.acct);
			// 查找用户
			const user = await this.usersRepository.findOne({
				where: {
					usernameLower: username.toLowerCase(),
					host: (host == null) || (host === this.config.host) ? IsNull() : host,
					isSuspended: false,
				},
			});

			// 设置缓存控制头（24小时）
			reply.header('Cache-Control', 'public, max-age=86400');

			// 如果用户存在，重定向到用户头像或生成的身份图标
			if (user) {
				reply.redirect(user.avatarUrl ?? this.userEntityService.getIdenticonUrl(user));
			} else {
				// 如果用户不存在，重定向到默认头像
				reply.redirect('/static-assets/user-unknown.png');
			}
		});

		// 身份图标生成路由
		fastify.get<{ Params: { x: string } }>('/identicon/:x', async (request, reply) => {
			// 设置响应头
			reply.header('Content-Type', 'image/png');
			reply.header('Cache-Control', 'public, max-age=86400');

			// 如果启用了身份图标生成，返回生成的图标
			if (this.meta.enableIdenticonGeneration) {
				return await genIdenticon(request.params.x);
			} else {
				// 否则重定向到默认头像
				return reply.redirect('/static-assets/avatar.png');
			}
		});

		// 邮箱验证路由
		fastify.get<{ Params: { code: string } }>('/verify-email/:code', async (request, reply) => {
			// 通过验证码查找用户档案
			const profile = await this.userProfilesRepository.findOneBy({
				emailVerifyCode: request.params.code,
			});

			// 如果找到匹配的档案
			if (profile != null) {
				// 更新用户档案，标记邮箱已验证并清除验证码
				await this.userProfilesRepository.update({ userId: profile.userId }, {
					emailVerified: true,
					emailVerifyCode: null,
				});

				// 发布用户更新事件到主流
				this.globalEventService.publishMainStream(profile.userId, 'meUpdated', await this.userEntityService.pack(profile.userId, { id: profile.userId }, {
					schema: 'MeDetailed',
					includeSecrets: true,
				}));

				// 返回成功消息
				reply.code(200).send('Verification succeeded! メールアドレスの認証に成功しました。');
				return;
			} else {
				// 如果未找到匹配的档案，返回404错误
				reply.code(404).send('Verification failed. Please try again. メールアドレスの認証に失敗しました。もう一度お試しください');
				return;
			}
		});

		// 注册客户端服务器
		fastify.register(this.clientServerService.createServer);

		// 附加流式 API 服务到服务器
		this.streamingApiServerService.attach(fastify.server);

		// 注册服务器错误处理
		fastify.server.on('error', err => {
			switch ((err as any).code) {
				case 'EACCES':
					// 没有权限监听端口
					this.logger.error(`You do not have permission to listen on port ${this.config.port}.`);
					break;
				case 'EADDRINUSE':
					// 端口已被占用
					this.logger.error(`Port ${this.config.port} is already in use by another process.`);
					break;
				default:
					// 其他错误
					this.logger.error(err);
					break;
			}

			// 如果是工作进程，向主进程发送失败消息
			if (cluster.isWorker) {
				process.send!('listenFailed');
			} else {
				// 禁用集群，直接退出进程
				process.exit(1);
			}
		});

		// 启动服务器
		if (this.config.socket) {
			// 如果配置了 UNIX 套接字
			if (fs.existsSync(this.config.socket)) {
				// 如果套接字文件已存在，删除它
				fs.unlinkSync(this.config.socket);
			}
			// 监听套接字
			fastify.listen({ path: this.config.socket }, (err, address) => {
				// 如果配置了套接字权限，设置权限
				if (this.config.chmodSocket) {
					fs.chmodSync(this.config.socket!, this.config.chmodSocket);
				}
			});
		} else {
			// 否则监听配置的端口，绑定所有接口
			fastify.listen({ port: this.config.port, host: '0.0.0.0' });
		}

		// 等待 Fastify 就绪
		await fastify.ready();
	}

	// 绑定this上下文并释放资源
	@bindThis
	public async dispose(): Promise<void> {
		// 分离流式 API 服务
		await this.streamingApiServerService.detach();
		// 关闭 Fastify 实例
		await this.#fastify.close();
	}

	// 实现 OnApplicationShutdown 接口的方法，在应用关闭时释放资源
	@bindThis
	async onApplicationShutdown(signal: string): Promise<void> {
		await this.dispose();
	}
}

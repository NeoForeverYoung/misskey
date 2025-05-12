/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 导入 NestJS 的依赖注入装饰器
import { Inject, Injectable } from '@nestjs/common';
// 导入 CORS 中间件，允许跨域请求
import cors from '@fastify/cors';
// 导入多部分表单数据处理中间件，用于文件上传
import multipart from '@fastify/multipart';
// 导入 NestJS 模块引用，用于获取动态注册的服务
import { ModuleRef } from '@nestjs/core';
// 导入 WebAuthn 身份验证响应类型（用于无密码认证）
import { AuthenticationResponseJSON } from '@simplewebauthn/types';
// 导入配置类型
import type { Config } from '@/config.js';
// 导入数据库仓库类型，用于访问实例和令牌数据
import type { InstancesRepository, AccessTokensRepository } from '@/models/_.js';
// 导入依赖注入符号，用于标识注入的依赖
import { DI } from '@/di-symbols.js';
// 导入用户实体服务，用于处理用户相关数据
import { UserEntityService } from '@/core/entities/UserEntityService.js';
// 导入方法绑定装饰器，确保方法中的 this 指向正确
import { bindThis } from '@/decorators.js';
// 导入所有 API 端点定义，包含了系统所有可用的 API 接口
import endpoints from './endpoints.js';
// 导入 API 调用服务，用于处理 API 请求的核心逻辑
import { ApiCallService } from './ApiCallService.js';
// 导入注册 API 服务，处理用户注册相关功能
import { SignupApiService } from './SignupApiService.js';
// 导入登录 API 服务，处理用户登录相关功能
import { SigninApiService } from './SigninApiService.js';
// 导入密钥登录 API 服务，处理 WebAuthn 无密码登录功能
import { SigninWithPasskeyApiService } from './SigninWithPasskeyApiService.js';
// 导入 Fastify 类型，用于类型检查和代码提示
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

// 标记为可注入的服务，允许 NestJS 在需要时实例化并注入此服务
@Injectable()
export class ApiServerService {
	// 构造函数，通过依赖注入接收所需的服务和资源
	constructor(
		// 注入模块引用，用于获取动态注册的端点执行器
		private moduleRef: ModuleRef,

		// 注入配置，包含服务器配置信息
		@Inject(DI.config)
		private config: Config,

		// 注入实例仓库，用于获取联邦实例信息
		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		// 注入访问令牌仓库，用于验证身份和管理访问令牌
		@Inject(DI.accessTokensRepository)
		private accessTokensRepository: AccessTokensRepository,

		// 注入用户实体服务，用于获取和处理用户信息
		private userEntityService: UserEntityService,
		// 注入 API 调用服务，用于处理 API 请求的执行
		private apiCallService: ApiCallService,
		// 注入注册 API 服务，处理用户注册流程
		private signupApiService: SignupApiService,
		// 注入登录 API 服务，处理用户登录流程
		private signinApiService: SigninApiService,
		// 注入密钥登录 API 服务，处理 WebAuthn 无密码登录
		private signinWithPasskeyApiService: SigninWithPasskeyApiService,
	) {
		// 注释掉的代码，可能曾用于手动绑定 this 上下文，现在使用装饰器
		//this.createServer = this.createServer.bind(this);
	}

	// 绑定 this 上下文，创建 API 服务器
	// 这是 Fastify 插件格式的方法，用于向 Fastify 实例注册路由和中间件
	// TODO[JS] 这里的bindThis是啥意思？
	@bindThis
	public createServer(fastify: FastifyInstance, options: FastifyPluginOptions, done: (err?: Error) => void) {
		// 注册 CORS 中间件，允许所有源的跨域请求
		// 这使得 API 可以被任何来源的客户端调用
		fastify.register(cors, {
			origin: '*',
		});

		// 注册多部分表单数据处理中间件，设置文件大小和数量限制
		// 用于处理文件上传请求，如上传头像或媒体文件
		fastify.register(multipart, {
			limits: {
				fileSize: this.config.maxFileSize, // 最大文件大小，来自配置
				files: 1, // 最多上传1个文件
			},
		});

		// 添加请求钩子，防止缓存
		// 确保 API 响应不会被客户端缓存，始终获取最新数据
		fastify.addHook('onRequest', (request, reply, done) => {
			reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
			done();
		});

		// 遍历所有端点，动态注册路由
		// endpoints 数组包含了系统中所有定义的 API 端点
		for (const endpoint of endpoints) {
			// 构造端点对象，包含名称、元数据、参数和执行函数
			// 通过模块引用获取对应端点的执行器
			const ep = {
				name: endpoint.name,
				meta: endpoint.meta,
				params: endpoint.params,
				// 从模块引用中获取端点执行器，使用 'ep:' 前缀
				exec: this.moduleRef.get('ep:' + endpoint.name, { strict: false }).exec,
			};

			// 如果端点需要文件上传，使用特殊的处理方式
			if (endpoint.meta.requireFile) {
				// 注册处理文件上传的路由
				// 使用 fastify.all 处理所有 HTTP 方法
				fastify.all<{
					Params: { endpoint: string; },
					Body: Record<string, unknown>,
					Querystring: Record<string, unknown>,
				}>('/' + endpoint.name, async (request, reply) => {
					// 如果是 GET 请求但端点不允许 GET 方法，返回 405 方法不允许
					if (request.method === 'GET' && !endpoint.meta.allowGet) {
						reply.code(405);
						reply.send();
						return;
					}

					// 调用 API 调用服务处理多部分请求，包含文件上传
					// 等待处理完成，以便自动将错误转换为 HTTP 500
					await this.apiCallService.handleMultipartRequest(ep, request, reply);
					return reply;
				});
			} else {
				// 注册普通请求的路由（不含文件上传）
				// 设置请求体大小限制为 1MB
				fastify.all<{
					Params: { endpoint: string; },
					Body: Record<string, unknown>,
					Querystring: Record<string, unknown>,
				}>('/' + endpoint.name, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
					// 如果是 GET 请求但端点不允许 GET 方法，返回 405 方法不允许
					if (request.method === 'GET' && !endpoint.meta.allowGet) {
						reply.code(405);
						reply.send();
						return;
					}

					// 调用 API 调用服务处理普通请求
					// 等待处理完成，以便自动将错误转换为 HTTP 500
					await this.apiCallService.handleRequest(ep, request, reply);
					return reply;
				});
			}
		}

		// 注册账户注册路由
		// 处理用户注册请求，支持邀请码和各种验证码
		fastify.post<{
			Body: {
				username: string;  // 用户名
				password: string;  // 密码
				host?: string;     // 主机（可选）
				invitationCode?: string;  // 邀请码（可选）
				emailAddress?: string;    // 电子邮件地址（可选）
				// 各种验证码响应（可选）
				'hcaptcha-response'?: string;
				'g-recaptcha-response'?: string;
				'turnstile-response'?: string;
				'm-captcha-response'?: string;
				'testcaptcha-response'?: string;
			}
		}>('/signup', (request, reply) => this.signupApiService.signup(request, reply));

		// 登录流程路由
		// 这里定义了一个 POST 请求，路径是 /signin-flow
		// 使用 TypeScript 泛型定义请求体的结构，包含用户身份验证所需的各种信息
		fastify.post<{
			Body: {
				username: string;  // 用户名
				password?: string; // 密码（可选）
				token?: string;    // 令牌（可选，用于两因素认证）
				credential?: AuthenticationResponseJSON;  // WebAuthn 凭证（可选，用于无密码登录）
				// 各种验证码响应（可选，用于防止自动化攻击）
				'hcaptcha-response'?: string;
				'g-recaptcha-response'?: string;
				'turnstile-response'?: string;
				'm-captcha-response'?: string;
				'testcaptcha-response'?: string;
			};
		}>('/signin-flow', (request, reply) => this.signinApiService.signin(request, reply));

		// 通过密钥登录路由
		// 处理 WebAuthn 无密码登录请求
		fastify.post<{
			Body: {
				credential?: AuthenticationResponseJSON;  // WebAuthn 凭证（可选）
				context?: string;  // 上下文（可选）
			};
		}>('/signin-with-passkey', (request, reply) => this.signinWithPasskeyApiService.signin(request, reply));

		// 注册待处理注册路由
		// 用于验证码验证后的注册完成，接收验证码并完成注册过程
		fastify.post<{ Body: { code: string; } }>('/signup-pending', (request, reply) => this.signupApiService.signupPending(request, reply));

		// 注册获取联邦实例对等点路由
		// 返回与此实例相连接的其他活跃 Misskey 实例列表
		fastify.get('/v1/instance/peers', async (request, reply) => {
			// 查找所有未被挂起的实例
			// 从数据库中获取状态正常的联邦实例
			const instances = await this.instancesRepository.find({
				select: ['host'],  // 只选择主机名
				where: {
					suspensionState: 'none',  // 未被挂起
				},
			});

			// 返回主机名数组
			// 将实例对象列表转换为主机名数组
			return instances.map(instance => instance.host);
		});

		// 注册 Misskey 认证检查路由
		// 处理 MiAuth 认证流程的最后一步，验证会话并返回令牌
		fastify.post<{ Params: { session: string; } }>('/miauth/:session/check', async (request, reply) => {
			// 通过会话查找访问令牌
			// 在数据库中查找与会话 ID 匹配的令牌
			const token = await this.accessTokensRepository.findOneBy({
				session: request.params.session,
			});

			// 如果令牌存在、会话不为空且未被获取过
			// 验证令牌的有效性
			if (token && token.session != null && !token.fetched) {
				// 更新令牌为已获取
				// 标记令牌已被使用，防止重复使用
				this.accessTokensRepository.update(token.id, {
					fetched: true,
				});

				// 返回成功响应，包含令牌和用户信息
				// 提供客户端需要的认证信息
				return {
					ok: true,
					token: token.token,
					user: await this.userEntityService.pack(token.userId, null, { schema: 'UserDetailedNotMe' }),
				};
			} else {
				// 返回失败响应
				// 如果令牌无效或已被使用，返回失败
				return {
					ok: false,
				};
			}
		});

		// 捕获所有未匹配的路径，返回 404 未找到
		// 确保 /api 下的任何未知路径返回 HTTP 404 Not Found，
		// 因为否则 ClientServerService 将返回基本客户端 HTML 页面，状态码为 HTTP 200。
		fastify.get('/*', (request, reply) => {
			reply.code(404);
			// 模拟 ApiCallService.send 的错误处理
			// 返回标准格式的错误响应
			reply.send({
				error: {
					message: 'Unknown API endpoint.',  // 未知 API 端点
					code: 'UNKNOWN_API_ENDPOINT',      // 错误代码
					id: '2ca3b769-540a-4f08-9dd5-b5a825b6d0f1',  // 错误 ID
					kind: 'client',                     // 错误类型
				},
			});
		});

		// 插件注册完成
		// 调用 done 回调，通知 Fastify 此插件已注册完成
		done();
	}
}

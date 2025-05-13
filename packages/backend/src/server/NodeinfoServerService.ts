/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MetaService } from '@/core/MetaService.js';
import { MAX_NOTE_TEXT_LENGTH } from '@/const.js';
import { MemorySingleCache } from '@/misc/cache.js';
import { bindThis } from '@/decorators.js';
import NotesChart from '@/core/chart/charts/notes.js';
import UsersChart from '@/core/chart/charts/users.js';
import { DEFAULT_POLICIES } from '@/core/RoleService.js';
import { SystemAccountService } from '@/core/SystemAccountService.js';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

// NodeInfo API 的路径配置
const nodeinfo2_1path = '/nodeinfo/2.1';
const nodeinfo2_0path = '/nodeinfo/2.0';
const nodeinfo_homepage = 'https://misskey-hub.net';

/**
 * NodeinfoServerService 类
 * 提供 NodeInfo 协议相关的服务
 * NodeInfo 是一种用于联邦宇宙（Fediverse）服务器间交换元数据的标准
 */
@Injectable()
export class NodeinfoServerService {
	constructor(
		// 注入配置服务
		@Inject(DI.config)
		private config: Config,

		// 注入系统账号服务
		private systemAccountService: SystemAccountService,
		// 注入元数据服务
		private metaService: MetaService,
		// 注入笔记统计图表服务
		private notesChart: NotesChart,
		// 注入用户统计图表服务
		private usersChart: UsersChart,
	) {
		//this.createServer = this.createServer.bind(this);
	}

	/**
	 * 获取 NodeInfo 的链接信息
	 * 用于告知其他服务器可用的 NodeInfo 版本及其链接
	 */
	@bindThis
	public getLinks() {
		return [{
			rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
			href: this.config.url + nodeinfo2_1path,
		}, {
			rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
			href: this.config.url + nodeinfo2_0path,
		}];
	}

	/**
	 * 创建 NodeInfo 服务器
	 * 处理 NodeInfo 相关的 API 请求
	 */
	@bindThis
	public createServer(fastify: FastifyInstance, options: FastifyPluginOptions, done: (err?: Error) => void) {
		/**
		 * 生成 NodeInfo 文档信息
		 * @param version NodeInfo 版本号
		 */
		const nodeinfo2 = async (version: number) => {
			const now = Date.now();

			// 获取笔记数据图表
			const notesChart = await this.notesChart.getChart('hour', 1, null);
			const localPosts = notesChart.local.total[0];

			// 获取用户数据图表
			const usersChart = await this.usersChart.getChart('hour', 1, null);
			const total = usersChart.local.total[0];

			// 获取服务器元数据
			const [
				meta,
				//activeHalfyear,
				//activeMonth,
			] = await Promise.all([
				this.metaService.fetch(true),
				// 以下查询比较重，暂时禁用
				//this.usersRepository.count({ where: { host: IsNull(), lastActiveDate: MoreThan(new Date(now - 15552000000)) } }),
				//this.usersRepository.count({ where: { host: IsNull(), lastActiveDate: MoreThan(new Date(now - 2592000000)) } }),
			]);

			// 临时设置活跃用户数为 null
			const activeHalfyear = null;
			const activeMonth = null;

			// 获取代理账号信息
			const proxyAccount = await this.systemAccountService.fetch('proxy');

			// 合并默认策略和自定义策略
			const basePolicies = { ...DEFAULT_POLICIES, ...meta.policies };

			// 构建 NodeInfo 文档
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const document: any = {
				software: {
					name: 'misskey',
					version: this.config.version,
					homepage: nodeinfo_homepage,
					repository: meta.repositoryUrl,
				},
				protocols: ['activitypub'],
				services: {
					inbound: [] as string[],
					outbound: ['atom1.0', 'rss2.0'],
				},
				openRegistrations: !meta.disableRegistration,
				usage: {
					users: { total, activeHalfyear, activeMonth },
					localPosts,
					localComments: 0,
				},
				metadata: {
					nodeName: meta.name,
					nodeDescription: meta.description,
					nodeAdmins: [{
						name: meta.maintainerName,
						email: meta.maintainerEmail,
					}],
					// 已废弃的维护者信息格式
					maintainer: {
						name: meta.maintainerName,
						email: meta.maintainerEmail,
					},
					langs: meta.langs,
					tosUrl: meta.termsOfServiceUrl,
					privacyPolicyUrl: meta.privacyPolicyUrl,
					inquiryUrl: meta.inquiryUrl,
					impressumUrl: meta.impressumUrl,
					repositoryUrl: meta.repositoryUrl,
					feedbackUrl: meta.feedbackUrl,
					disableRegistration: meta.disableRegistration,
					// 以下是时间线相关的配置
					disableLocalTimeline: !basePolicies.ltlAvailable,  // 本地时间线(LocalTimeline)是否可用
					disableGlobalTimeline: !basePolicies.gtlAvailable, // 全局时间线(GlobalTimeline)是否可用
					emailRequiredForSignup: meta.emailRequiredForSignup,
					enableHcaptcha: meta.enableHcaptcha,
					enableRecaptcha: meta.enableRecaptcha,
					enableMcaptcha: meta.enableMcaptcha,
					enableTurnstile: meta.enableTurnstile,
					maxNoteTextLength: MAX_NOTE_TEXT_LENGTH,
					enableEmail: meta.enableEmail,
					enableServiceWorker: meta.enableServiceWorker,
					proxyAccountName: proxyAccount.username,
					themeColor: meta.themeColor ?? '#86b300',
				},
			};
			// 根据 NodeInfo 版本调整文档内容
			if (version >= 21) {
				document.software.repository = meta.repositoryUrl;
				document.software.homepage = meta.repositoryUrl;
			}
			return document;
		};

		// 创建缓存，减少重复计算，缓存时间为10分钟
		const cache = new MemorySingleCache<Awaited<ReturnType<typeof nodeinfo2>>>(1000 * 60 * 10); // 10m

		// 处理 NodeInfo 2.1 版本的请求
		fastify.get(nodeinfo2_1path, async (request, reply) => {
			const base = await cache.fetch(() => nodeinfo2(21));

			reply
				.type(
					'application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.1#"',
				)
				.header('Cache-Control', 'public, max-age=600')
				.header('Access-Control-Allow-Headers', 'Accept')
				.header('Access-Control-Allow-Methods', 'GET, OPTIONS')
				.header('Access-Control-Allow-Origin', '*')
				.header('Access-Control-Expose-Headers', 'Vary');
			return { version: '2.1', ...base };
		});

		// 处理 NodeInfo 2.0 版本的请求
		fastify.get(nodeinfo2_0path, async (request, reply) => {
			const base = await cache.fetch(() => nodeinfo2(20));

			// 移除2.0版本不支持的字段
			delete (base as any).software.repository;

			reply
				.type(
					'application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.0#"',
				)
				.header('Cache-Control', 'public, max-age=600')
				.header('Access-Control-Allow-Headers', 'Accept')
				.header('Access-Control-Allow-Methods', 'GET, OPTIONS')
				.header('Access-Control-Allow-Origin', '*')
				.header('Access-Control-Expose-Headers', 'Vary');
			return { version: '2.0', ...base };
		});

		done();
	}
}

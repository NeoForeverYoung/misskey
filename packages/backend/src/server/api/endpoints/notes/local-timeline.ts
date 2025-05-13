/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Brackets } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import type { MiMeta, NotesRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import ActiveUsersChart from '@/core/chart/charts/active-users.js';
import { DI } from '@/di-symbols.js';
import { RoleService } from '@/core/RoleService.js';
import { IdService } from '@/core/IdService.js';
import { QueryService } from '@/core/QueryService.js';
import { MiLocalUser } from '@/models/User.js';
import { FanoutTimelineEndpointService } from '@/core/FanoutTimelineEndpointService.js';
import { ApiError } from '../../error.js';

// API 元数据定义，包含标签、返回类型和可能的错误
export const meta = {
	tags: ['notes'],

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'Note',
		},
	},

	errors: {
		ltlDisabled: {
			message: 'Local timeline has been disabled.',
			code: 'LTL_DISABLED',
			id: '45a6eb02-7695-4393-b023-dd3be9aaaefd',
		},

		bothWithRepliesAndWithFiles: {
			message: 'Specifying both withReplies and withFiles is not supported',
			code: 'BOTH_WITH_REPLIES_AND_WITH_FILES',
			id: 'dd9c8400-1cb5-4eef-8a31-200c5f933793',
		},
	},
} as const;

// API 参数定义，指定请求时可用的查询参数
export const paramDef = {
	type: 'object',
	properties: {
		withFiles: { type: 'boolean', default: false },     // 是否只显示包含文件的笔记
		withRenotes: { type: 'boolean', default: true },    // 是否包含转发的笔记
		withReplies: { type: 'boolean', default: false },   // 是否包含回复
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },  // 返回笔记的数量限制
		sinceId: { type: 'string', format: 'misskey:id' },  // 起始ID (获取比这个ID更新的笔记)
		untilId: { type: 'string', format: 'misskey:id' },  // 结束ID (获取比这个ID更早的笔记)
		allowPartial: { type: 'boolean', default: false },  // 是否允许部分结果 (为兼容性默认为false)
		sinceDate: { type: 'integer' },                     // 起始日期时间戳
		untilDate: { type: 'integer' },                     // 结束日期时间戳
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.meta)
		private serverSettings: MiMeta,  // 服务器元数据配置

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,  // 笔记仓库，用于数据库操作

		private noteEntityService: NoteEntityService,  // 笔记实体服务，用于打包笔记数据
		private roleService: RoleService,              // 角色服务，用于检查用户权限
		private activeUsersChart: ActiveUsersChart,    // 活跃用户图表，用于统计
		private idService: IdService,                  // ID服务，用于生成和解析ID
		private fanoutTimelineEndpointService: FanoutTimelineEndpointService,  // 时间线扇出服务
		private queryService: QueryService,            // 查询服务，用于构建复杂查询
	) {
		super(meta, paramDef, async (ps, me) => {
			// 处理日期参数，转换为ID
			const untilId = ps.untilId ?? (ps.untilDate ? this.idService.gen(ps.untilDate!) : null);
			const sinceId = ps.sinceId ?? (ps.sinceDate ? this.idService.gen(ps.sinceDate!) : null);

			// 检查用户是否有访问本地时间线的权限
			const policies = await this.roleService.getUserPolicies(me ? me.id : null);
			if (!policies.ltlAvailable) {
				throw new ApiError(meta.errors.ltlDisabled);
			}

			// 不支持同时指定withReplies和withFiles
			if (ps.withReplies && ps.withFiles) throw new ApiError(meta.errors.bothWithRepliesAndWithFiles);

			// 如果未启用扇出时间线功能，则直接从数据库获取
			if (!this.serverSettings.enableFanoutTimeline) {
				const timeline = await this.getFromDb({
					untilId,
					sinceId,
					limit: ps.limit,
					withFiles: ps.withFiles,
					withReplies: ps.withReplies,
				}, me);

				// 异步记录用户阅读统计
				process.nextTick(() => {
					if (me) {
						this.activeUsersChart.read(me);
					}
				});

				// 打包笔记数据后返回
				return await this.noteEntityService.packMany(timeline, me);
			}

			// 使用扇出时间线服务获取时间线数据
			const timeline = await this.fanoutTimelineEndpointService.timeline({
				untilId,
				sinceId,
				limit: ps.limit,
				allowPartial: ps.allowPartial,
				me,
				useDbFallback: this.serverSettings.enableFanoutTimelineDbFallback,
				// 根据不同参数选择不同的Redis时间线键
				redisTimelines:
					ps.withFiles ? ['localTimelineWithFiles']  // 只有带文件的本地时间线
					: ps.withReplies ? ['localTimeline', 'localTimelineWithReplies']  // 本地时间线加带回复的本地时间线
					: me ? ['localTimeline', `localTimelineWithReplyTo:${me.id}`]    // 本地时间线加对指定用户的回复
					: ['localTimeline'],  // 默认本地时间线
				alwaysIncludeMyNotes: true,  // 总是包含自己的笔记
				excludePureRenotes: !ps.withRenotes,  // 是否排除纯转发
				// 如果Redis缓存不可用，使用数据库作为后备方案
				dbFallback: async (untilId, sinceId, limit) => await this.getFromDb({
					untilId,
					sinceId,
					limit,
					withFiles: ps.withFiles,
					withReplies: ps.withReplies,
				}, me),
			});

			// 异步记录用户阅读统计
			process.nextTick(() => {
				if (me) {
					this.activeUsersChart.read(me);
				}
			});

			return timeline;
		});
	}

	/**
	 * 从数据库获取本地时间线数据
	 * @param ps 查询参数
	 * @param me 当前用户
	 * @returns 笔记列表
	 */
	private async getFromDb(ps: {
		sinceId: string | null,
		untilId: string | null,
		limit: number,
		withFiles: boolean,
		withReplies: boolean,
	}, me: MiLocalUser | null) {
		// 创建基础分页查询
		const query = this.queryService.makePaginationQuery(this.notesRepository.createQueryBuilder('note'),
			ps.sinceId, ps.untilId)
			// 只获取公开的、本地用户发布的、不在频道内的笔记
			.andWhere('(note.visibility = \'public\') AND (note.userHost IS NULL) AND (note.channelId IS NULL)')
			// 关联笔记相关的用户和其他信息
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		// 应用可见性筛选
		this.queryService.generateVisibilityQuery(query, me);
		
		// 如果有用户登录，应用各种过滤条件
		if (me) this.queryService.generateMutedUserQueryForNotes(query, me);  // 过滤静音的用户
		if (me) this.queryService.generateBlockedUserQueryForNotes(query, me);  // 过滤屏蔽的用户
		if (me) this.queryService.generateMutedUserRenotesQueryForNotes(query, me);  // 过滤静音用户的转发

		// 如果需要只显示带文件的笔记
		if (ps.withFiles) {
			query.andWhere('note.fileIds != \'{}\'');
		}

		// 如果不需要显示回复
		if (!ps.withReplies) {
			query.andWhere(new Brackets(qb => {
				qb
					.where('note.replyId IS NULL') // 不是回复
					.orWhere(new Brackets(qb => {
						qb // 是回复但是回复给自己的
							.where('note.replyId IS NOT NULL')
							.andWhere('note.replyUserId = note.userId');
					}));
			}));
		}

		// 执行查询并返回结果
		return await query.limit(ps.limit).getMany();
	}
}

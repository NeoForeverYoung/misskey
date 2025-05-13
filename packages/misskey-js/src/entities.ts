import { ModerationLogPayloads } from './consts.js';
import {
	Announcement,
	EmojiDetailed,
	MeDetailed,
	Note,
	Page,
	Role,
	RolePolicies,
	User,
	UserDetailedNotMe,
} from './autogen/models.js';
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/types';

export * from './autogen/entities.js';
export * from './autogen/models.js';

export type ID = string;
export type DateString = string;

type NonNullableRecord<T> = {
	[P in keyof T]-?: NonNullable<T[P]>;
};
type AllNullRecord<T> = {
	[P in keyof T]: null;
};

/**
 * 纯转发笔记类型
 * 只包含转发信息，不包含自己的内容
 */
export type PureRenote =
	Omit<Note, 'renote' | 'renoteId' | 'reply' | 'replyId' | 'text' | 'cw' | 'files' | 'fileIds' | 'poll'>
	& AllNullRecord<Pick<Note, 'reply' | 'replyId' | 'text' | 'cw' | 'poll'>>
	& { files: []; fileIds: []; }
	& NonNullableRecord<Pick<Note, 'renote' | 'renoteId'>>;

/**
 * 页面事件类型
 * 用于处理自定义页面中的交互事件
 */
export type PageEvent = {
	pageId: Page['id'];      // 页面ID
	event: string;           // 事件名称
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	var: any;                // 事件变量
	userId: User['id'];      // 用户ID
	user: User;              // 用户对象
};

/**
 * 管理日志类型
 * 记录管理员执行的各种操作
 */
export type ModerationLog = {
	id: ID;                  // 日志ID
	createdAt: DateString;   // 创建时间
	userId: User['id'];      // 执行操作的用户ID
	user: UserDetailedNotMe | null; // 执行操作的用户详情
} & ({
	// 以下是各种管理操作类型及其对应的信息
	type: 'updateServerSettings';
	info: ModerationLogPayloads['updateServerSettings'];
} | {
	type: 'suspend';
	info: ModerationLogPayloads['suspend'];
} | {
	type: 'unsuspend';
	info: ModerationLogPayloads['unsuspend'];
} | {
	type: 'updateUserNote';
	info: ModerationLogPayloads['updateUserNote'];
} | {
	type: 'addCustomEmoji';
	info: ModerationLogPayloads['addCustomEmoji'];
} | {
	type: 'updateCustomEmoji';
	info: ModerationLogPayloads['updateCustomEmoji'];
} | {
	type: 'deleteCustomEmoji';
	info: ModerationLogPayloads['deleteCustomEmoji'];
} | {
	type: 'assignRole';
	info: ModerationLogPayloads['assignRole'];
} | {
	type: 'unassignRole';
	info: ModerationLogPayloads['unassignRole'];
} | {
	type: 'createRole';
	info: ModerationLogPayloads['createRole'];
} | {
	type: 'updateRole';
	info: ModerationLogPayloads['updateRole'];
} | {
	type: 'deleteRole';
	info: ModerationLogPayloads['deleteRole'];
} | {
	type: 'clearQueue';
	info: ModerationLogPayloads['clearQueue'];
} | {
	type: 'promoteQueue';
	info: ModerationLogPayloads['promoteQueue'];
} | {
	type: 'deleteDriveFile';
	info: ModerationLogPayloads['deleteDriveFile'];
} | {
	type: 'deleteNote';
	info: ModerationLogPayloads['deleteNote'];
} | {
	type: 'createGlobalAnnouncement';
	info: ModerationLogPayloads['createGlobalAnnouncement'];
} | {
	type: 'createUserAnnouncement';
	info: ModerationLogPayloads['createUserAnnouncement'];
} | {
	type: 'updateGlobalAnnouncement';
	info: ModerationLogPayloads['updateGlobalAnnouncement'];
} | {
	type: 'updateUserAnnouncement';
	info: ModerationLogPayloads['updateUserAnnouncement'];
} | {
	type: 'deleteGlobalAnnouncement';
	info: ModerationLogPayloads['deleteGlobalAnnouncement'];
} | {
	type: 'deleteUserAnnouncement';
	info: ModerationLogPayloads['deleteUserAnnouncement'];
} | {
	type: 'resetPassword';
	info: ModerationLogPayloads['resetPassword'];
} | {
	type: 'suspendRemoteInstance';
	info: ModerationLogPayloads['suspendRemoteInstance'];
} | {
	type: 'unsuspendRemoteInstance';
	info: ModerationLogPayloads['unsuspendRemoteInstance'];
} | {
	type: 'updateRemoteInstanceNote';
	info: ModerationLogPayloads['updateRemoteInstanceNote'];
} | {
	type: 'markSensitiveDriveFile';
	info: ModerationLogPayloads['markSensitiveDriveFile'];
} | {
	type: 'unmarkSensitiveDriveFile';
	info: ModerationLogPayloads['unmarkSensitiveDriveFile'];
} | {
	type: 'createInvitation';
	info: ModerationLogPayloads['createInvitation'];
} | {
	type: 'createAd';
	info: ModerationLogPayloads['createAd'];
} | {
	type: 'updateAd';
	info: ModerationLogPayloads['updateAd'];
} | {
	type: 'deleteAd';
	info: ModerationLogPayloads['deleteAd'];
} | {
	type: 'createAvatarDecoration';
	info: ModerationLogPayloads['createAvatarDecoration'];
} | {
	type: 'updateAvatarDecoration';
	info: ModerationLogPayloads['updateAvatarDecoration'];
} | {
	type: 'deleteAvatarDecoration';
	info: ModerationLogPayloads['deleteAvatarDecoration'];
} | {
	type: 'resolveAbuseReport';
	info: ModerationLogPayloads['resolveAbuseReport'];
} | {
	type: 'forwardAbuseReport';
	info: ModerationLogPayloads['forwardAbuseReport'];
} | {
	type: 'updateAbuseReportNote';
	info: ModerationLogPayloads['updateAbuseReportNote'];
} | {
	type: 'unsetUserAvatar';
	info: ModerationLogPayloads['unsetUserAvatar'];
} | {
	type: 'unsetUserBanner';
	info: ModerationLogPayloads['unsetUserBanner'];
} | {
	type: 'createSystemWebhook';
	info: ModerationLogPayloads['createSystemWebhook'];
} | {
	type: 'updateSystemWebhook';
	info: ModerationLogPayloads['updateSystemWebhook'];
} | {
	type: 'deleteSystemWebhook';
	info: ModerationLogPayloads['deleteSystemWebhook'];
} | {
	type: 'createAbuseReportNotificationRecipient';
	info: ModerationLogPayloads['createAbuseReportNotificationRecipient'];
} | {
	type: 'updateAbuseReportNotificationRecipient';
	info: ModerationLogPayloads['updateAbuseReportNotificationRecipient'];
} | {
	type: 'deleteAbuseReportNotificationRecipient';
	info: ModerationLogPayloads['deleteAbuseReportNotificationRecipient'];
} | {
	type: 'deleteAccount';
	info: ModerationLogPayloads['deleteAccount'];
} | {
	type: 'deletePage';
	info: ModerationLogPayloads['deletePage'];
} | {
	type: 'deleteFlash';
	info: ModerationLogPayloads['deleteFlash'];
} | {
	type: 'deleteGalleryPost';
	info: ModerationLogPayloads['deleteGalleryPost'];
} | {
	type: 'deleteChatRoom';
	info: ModerationLogPayloads['deleteChatRoom'];
});

/**
 * 服务器状态统计类型
 * 记录服务器的资源使用情况
 */
export type ServerStats = {
	cpu: number;             // CPU使用率
	mem: {
		used: number;        // 已使用内存
		active: number;      // 活跃内存
	};
	net: {
		rx: number;          // 接收的网络流量
		tx: number;          // 发送的网络流量
	};
	fs: {
		r: number;           // 文件系统读取量
		w: number;           // 文件系统写入量
	}
};

/**
 * 服务器状态日志类型
 * 记录一段时间内的服务器状态
 */
export type ServerStatsLog = ServerStats[];

/**
 * 队列统计类型
 * 记录任务队列的状态
 */
export type QueueStats = {
	deliver: {               // 投递队列
		activeSincePrevTick: number; // 上次检查后的活跃任务数
		active: number;      // 当前活跃任务数
		waiting: number;     // 等待中的任务数
		delayed: number;     // 延迟执行的任务数
	};
	inbox: {                 // 收件箱队列
		activeSincePrevTick: number; // 上次检查后的活跃任务数
		active: number;      // 当前活跃任务数
		waiting: number;     // 等待中的任务数
		delayed: number;     // 延迟执行的任务数
	};
};

/**
 * 队列统计日志类型
 * 记录一段时间内的队列状态
 */
export type QueueStatsLog = QueueStats[];

/**
 * 表情添加事件类型
 */
export type EmojiAdded = {
	emoji: EmojiDetailed    // 添加的表情详情
};

/**
 * 表情更新事件类型
 */
export type EmojiUpdated = {
	emojis: EmojiDetailed[] // 更新的表情列表
};

/**
 * 表情删除事件类型
 */
export type EmojiDeleted = {
	emojis: EmojiDetailed[] // 删除的表情列表
};

/**
 * 公告创建事件类型
 */
export type AnnouncementCreated = {
	announcement: Announcement; // 创建的公告
};

/**
 * 注册请求类型
 * 用户注册时提交的信息
 */
export type SignupRequest = {
	username: string;        // 用户名
	password: string;        // 密码
	host?: string;           // 主机名（可选）
	invitationCode?: string; // 邀请码（可选）
	emailAddress?: string;   // 电子邮件地址（可选）
	'hcaptcha-response'?: string | null;      // hCaptcha响应（可选）
	'g-recaptcha-response'?: string | null;   // Google reCAPTCHA响应（可选）
	'turnstile-response'?: string | null;     // Cloudflare Turnstile响应（可选）
	'm-captcha-response'?: string | null;     // mCaptcha响应（可选）
};

/**
 * 注册响应类型
 * 用户注册成功后返回的信息
 */
export type SignupResponse = MeDetailed & {
	token: string;           // 认证令牌
};

/**
 * 待处理注册请求类型
 * 用于处理需要邮箱验证等待确认的注册
 */
export type SignupPendingRequest = {
	code: string;            // 验证码
};

/**
 * 待处理注册响应类型
 */
export type SignupPendingResponse = {
	id: User['id'],          // 用户ID
	i: string,               // 认证令牌
};

/**
 * 登录流程请求类型
 * 用户登录时提交的信息
 */
export type SigninFlowRequest = {
	username: string;        // 用户名
	password?: string;       // 密码（可选）
	token?: string;          // 双因素认证令牌（可选）
	credential?: AuthenticationResponseJSON; // WebAuthn凭证（可选）
	'hcaptcha-response'?: string | null;     // hCaptcha响应（可选）
	'g-recaptcha-response'?: string | null;  // Google reCAPTCHA响应（可选）
	'turnstile-response'?: string | null;    // Cloudflare Turnstile响应（可选）
	'm-captcha-response'?: string | null;    // mCaptcha响应（可选）
};

/**
 * 登录流程响应类型
 * 描述登录过程中的各种状态和下一步操作
 */
export type SigninFlowResponse = {
	finished: true;          // 登录完成
	id: User['id'];          // 用户ID
	i: string;               // 认证令牌
} | {
	finished: false;         // 登录未完成
	next: 'captcha' | 'password' | 'totp'; // 下一步：验证码、密码或TOTP
} | {
	finished: false;         // 登录未完成
	next: 'passkey';         // 下一步：密钥认证
	authRequest: PublicKeyCredentialRequestOptionsJSON; // WebAuthn认证请求参数
};

/**
 * 使用密钥登录请求类型
 */
export type SigninWithPasskeyRequest = {
	credential?: AuthenticationResponseJSON; // WebAuthn凭证
	context?: string;        // 上下文信息
};

/**
 * 使用密钥登录初始化响应类型
 */
export type SigninWithPasskeyInitResponse = {
	option: PublicKeyCredentialRequestOptionsJSON; // WebAuthn请求选项
	context: string;         // 上下文信息
};

/**
 * 使用密钥登录响应类型
 */
export type SigninWithPasskeyResponse = {
	signinResponse: SigninFlowResponse & { finished: true }; // 登录完成的响应
};

// 获取对象中所有值的类型
type Values<T extends Record<PropertyKey, unknown>> = T[keyof T];

/**
 * 角色策略部分覆盖类型
 * 用于部分更新角色策略
 */
export type PartialRolePolicyOverride = Partial<{ [k in keyof RolePolicies]: Omit<Values<Role['policies']>, 'value'> & { value: RolePolicies[k] } }>;

/**
 * 工具 Schema 定义（纯声明，无 DB/运行时依赖）：主进程与 LLM 桥接子进程共用。
 * bridge 用 zod shape 构建 SDK MCP 工具 stub；主进程注册同名 handler 实际执行。
 */
import { z } from 'zod'

export interface ToolSchemaDef {
  name: string
  description: string
  /** zod raw shape（SDK tool 的 inputSchema） */
  zodShape: Record<string, z.ZodTypeAny>
}

export const TOOL_SCHEMAS: ToolSchemaDef[] = [
  // —— 市场数据 ——
  { name: 'search_symbols', description: '按代码或名称搜索 A 股标的，返回基础信息列表', zodShape: { keyword: z.string().describe('代码或名称关键字') } },
  { name: 'get_quote', description: '获取指定代码的实时行情快照', zodShape: { codes: z.array(z.string()).describe('股票代码数组') } },
  { name: 'get_kline', description: '获取指定代码的日线 K 线（区间内不复权原始数据 + 复权因子）', zodShape: { code: z.string(), start: z.string().describe('YYYY-MM-DD'), end: z.string().describe('YYYY-MM-DD') } },
  { name: 'get_index_overview', description: '获取主要指数（上证 000001 / 沪深300 000300 / 深证成指 399001）日线概览', zodShape: { code: z.string().describe('指数代码'), start: z.string(), end: z.string() } },
  { name: 'get_market_breadth', description: '获取市场简报：指数涨跌、涨跌家数', zodShape: {} },
  { name: 'get_data_status', description: '数据状态概览：各标的最后更新日与完整性标记', zodShape: {} },
  { name: 'get_data_stats', description: '本地数据统计：股票数、K 线行数、数据日期范围', zodShape: {} },
  { name: 'trigger_data_update', description: '触发当日数据增量更新（异步任务，已在运行则忽略；检测到数据缺失时可主动调用）', zodShape: {} },
  { name: 'web_search', description: '联网搜索最新信息（行情动态、政策新闻、公司公告、市场资讯），返回中文总结与来源链接。需要最新/实时信息时使用。', zodShape: { query: z.string().describe('搜索关键词或问题') } },
  // —— 策略管理 ——
  { name: 'create_strategy', description: '创建新策略（声明式 DSL，JSON 字符串；白名单指标校验失败会报错）', zodShape: { name: z.string(), dslJson: z.string().describe('策略 DSL JSON 字符串'), rationale: z.string().default('') } },
  { name: 'update_strategy', description: '更新策略 DSL（生成新版本留档）', zodShape: { strategyId: z.string(), dslJson: z.string(), changeLog: z.string().default('Agent 更新') } },
  { name: 'list_strategies', description: '列出策略库（全局共享：所有账户共用）', zodShape: {} },
  { name: 'get_strategy', description: '获取策略详情（DSL）', zodShape: { strategyId: z.string() } },
  { name: 'activate_strategy', description: '激活策略进入运行（受限操作：需人工批准流程）', zodShape: { strategyId: z.string() } },
  { name: 'deactivate_strategy', description: '停用策略（受限操作：纠正类动作，需批准流程）', zodShape: { strategyId: z.string(), reason: z.string().default('') } },
  // —— 回测 ——
  { name: 'run_backtest', description: '对策略版本发起回测（异步任务，返回 runId）', zodShape: { strategyVersionId: z.string(), start: z.string(), end: z.string() } },
  { name: 'get_backtest_result', description: '查询回测结果（指标与报告）', zodShape: { runId: z.string() } },
  { name: 'get_backtest_trades', description: '查询回测成交明细', zodShape: { runId: z.string() } },
  { name: 'list_backtests', description: '列出回测任务（全部策略版本，含状态与结论）', zodShape: {} },
  // —— 账户、资金与风控（资金/持仓按账户隔离） ——
  { name: 'list_accounts', description: '列出本地账户（账户隔离资金与持仓；数据/策略/模型全局通用）', zodShape: {} },
  { name: 'get_account_summary', description: '当前活跃账户概览：仓位、现金、持仓明细', zodShape: {} },
  { name: 'get_positions', description: '当前活跃账户持仓列表（人工维护）', zodShape: {} },
  { name: 'list_trade_records', description: '当前活跃账户成交记录（人工执行回填）', zodShape: { limit: z.number().int().min(1).max(500).default(100) } },
  { name: 'check_risk', description: '对拟生成的信号执行风控检查（只读校验）', zodShape: { code: z.string(), side: z.enum(['buy', 'sell']), qty: z.number(), refPrice: z.number() } },
  { name: 'publish_signal', description: '产出交易建议（信号）：需经风控校验后落库推送', zodShape: { runId: z.string(), strategyId: z.string(), code: z.string(), side: z.enum(['buy', 'sell']), qty: z.number().int(), refPrice: z.number(), basis: z.string().describe('触发依据说明') } },
  { name: 'list_signals', description: '当前活跃账户信号列表（含人工反馈状态）', zodShape: { limit: z.number().int().min(1).max(500).default(100) } },
  { name: 'list_run_instances', description: '运行实例列表（策略上线运行记录）', zodShape: {} },
  // —— 盯盘与预警 ——
  { name: 'raise_alert', description: '发布盯盘预警', zodShape: { level: z.enum(['info', 'warn', 'critical']), type: z.string(), content: z.string() } },
  { name: 'list_alerts', description: '预警列表（分级）', zodShape: { limit: z.number().int().min(1).max(200).default(50) } },
  { name: 'acknowledge_alert', description: '确认（关闭）一条预警', zodShape: { alertId: z.string() } },
  // —— 复盘与绩效 ——
  { name: 'list_review_reports', description: '复盘报告列表（日/周）', zodShape: { limit: z.number().int().min(1).max(100).default(20) } },
  { name: 'get_review_report', description: '复盘报告详情（含问题归因与纠正建议）', zodShape: { reviewId: z.string() } },
  { name: 'get_performance', description: '当前活跃账户绩效：净值指标、信号执行偏差、成交统计', zodShape: {} },
  // —— 汇报、计划与审计（系统状态自查） ——
  { name: 'list_reports', description: '汇报流列表（含待决策事项状态）', zodShape: { limit: z.number().int().min(1).max(200).default(50) } },
  { name: 'report_to_user', description: '向用户汇报（分级：result/summary/need_decision）', zodShape: { level: z.enum(['result', 'summary', 'need_decision']), title: z.string(), summary: z.string(), decisionJson: z.string().optional().describe('need_decision 时的决策选项 JSON') } },
  { name: 'get_plan', description: '当前阶段性行动计划', zodShape: { limit: z.number().int().min(1).max(20).default(5) } },
  { name: 'list_work_items', description: '工作项列表（Agent 任务队列状态自查）', zodShape: { limit: z.number().int().min(1).max(200).default(50) } },
  { name: 'list_audit_logs', description: '操作审计日志（按时间倒序）', zodShape: { limit: z.number().int().min(1).max(200).default(50) } },
  { name: 'list_events', description: 'Agent 事件流水（触发链路自查）', zodShape: { limit: z.number().int().min(1).max(200).default(50) } },
  { name: 'finish_workitem', description: '结束当前工作项并写执行摘要', zodShape: { summary: z.string() } }
]

export const TOOL_NAMES: string[] = TOOL_SCHEMAS.map((t) => t.name)

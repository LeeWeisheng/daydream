/**
 * 自动生成/迭代策略（strategist）：依据规划方向与市场数据生成/迭代账户唯一策略文档。
 * 策略 = 纯 Markdown 文本（交易策略 + 用户偏好等全部信息），是注入 Agent 的系统提示词主体。
 * 每次生成新版本留档（标题与变更记录由大模型生成），保存即生效，随后自动创建评估工作项。
 */
import { z } from 'zod'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { structuredOutput } from '../app/sessions'
import { STRATEGIST_PROMPT } from '../agent/prompts'
import { getStrategyForAccount, latestVersionId, saveStrategyMarkdown } from '../strategy/service'
import type { PipelineHost } from './index'

// 生成约束：LLM 输出策略文档（Markdown）+ 标题 + 一句话变更记录
const genSchema = z.object({
  title: z.string().min(1).max(40),
  changeLog: z.string().min(1).max(120),
  markdown: z.string().min(50).describe('完整策略 Markdown 文档（纯文本，无代码块）')
})

export async function runFromPlan(accountId: string, context: Record<string, unknown>, host?: PipelineHost): Promise<Record<string, unknown>> {
  const direction = String(context.direction ?? '未命名方向')
  const description = String(context.description ?? '')
  // 每账户唯一策略：读取现有文档（含用户偏好，迭代时保留用户偏好部分）
  const existing = getStrategyForAccount(accountId)
  const prompt = JSON.stringify(
    {
      direction,
      description,
      existingStrategy: existing ? { title: existing.title, version: existing.version, markdown: existing.markdown } : null,
      note: '每账户只有一份策略文档。输出完整策略 Markdown 文档：策略概述、市场判断框架、选股域、入场/出场条件、组合约束、用户偏好（保留现有偏好）、风控与执行纪律、信号标准；纯自然语言，量化指标写具体数值，禁止内嵌代码块。'
    },
    null,
    2
  )
  const generated = await structuredOutput(accountId, {
    system: STRATEGIST_PROMPT,
    prompt,
    schema: genSchema,
    purpose: `generate_strategy:${direction}`,
    useProModel: true
  })

  const strategy = saveStrategyMarkdown({
    accountId,
    title: generated.title,
    markdown: generated.markdown,
    changeLog: generated.changeLog,
    createdBy: 'agent'
  })
  audit({ accountId, actor: 'agent', action: 'strategy.generated', target: strategy.id, detail: { direction, version: strategy.version } })

  // 自动创建评估工作项（定性评估：逻辑自洽性/可执行性/与偏好一致性）
  const evalItem = host?.enqueueTicket({
    accountId,
    type: 'backtest',
    priority: 'medium',
    context: { strategyId: strategy.id, strategyVersionId: latestVersionId(strategy.id) ?? '', __busKey: `strategy:${strategy.id}` }
  })
  logger.info(`[pipeline] strategy generated: ${strategy.title} v${strategy.version} (${strategy.id}), eval workitem ${evalItem?.id ?? '-'}`)
  return { strategyId: strategy.id, title: strategy.title, version: strategy.version, evalWorkItemId: evalItem?.id }
}

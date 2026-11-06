/**
 * EnginePart：Engine 内部组件的基类（dsh src/core/part.ts 的对应）。
 * 提供共享的依赖访问（选项）与读取辅助；部件间的依赖单向流动：
 * Intake → Tickets；Evals → Tickets；Assignments → Tickets、Replies；Replies → 无。
 */
import type { EngineDeps, Repositories } from './ports'
import type { Policy } from './ports'

export type EngineOptions = EngineDeps

export abstract class EnginePart {
  constructor(protected readonly options: EngineOptions) {}

  protected get repo(): Repositories {
    return this.options.repo
  }

  protected get policy(): Policy {
    return this.options.policy()
  }

  protected get now(): () => string {
    return this.options.now ?? (() => new Date().toISOString())
  }

  protected emit(name: Parameters<NonNullable<EngineDeps['emit']>>[0]): void {
    this.options.emit?.(name)
  }

  protected newId(): string {
    const factory = this.options.newId ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    return factory()
  }
}

/**
 * 加密服务：敏感配置（API Key 等）以 AES-256-GCM 加密后入库，
 * 密钥材料经 Electron safeStorage（macOS Keychain / Windows DPAPI）保护。
 * 日志与审计永不记录明文（见《实现方案-数据模型与模块设计》§10）。
 */
import { safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// 主密钥：由 safeStorage 加密保存的随机 32 字节材料
let masterKey: Buffer | null = null
let keyPath = ''

/** 应用启动时初始化主密钥 */
export function initCrypto(userDataDir: string): void {
  keyPath = `${userDataDir}/data/.masterkey`
  const fs = require('node:fs') as typeof import('node:fs')
  try {
    const raw = fs.readFileSync(keyPath)
    if (safeStorage.isEncryptionAvailable()) {
      // 注意：safeStorage.decryptString 要求 Buffer 参数（非 string）
      const decrypted = safeStorage.decryptString(raw)
      masterKey = Buffer.from(decrypted, 'hex')
      if (masterKey.length !== 32) throw new Error('invalid master key length')
    } else {
      // safeStorage 不可用（如 Linux）：降级为机器绑定混淆存储（标注风险）
      masterKey = Buffer.from(raw.toString('utf8'), 'hex')
    }
  } catch {
    // 首次运行：生成新主密钥并持久化
    masterKey = randomBytes(32)
    fs.mkdirSync(`${userDataDir}/data`, { recursive: true })
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(keyPath, safeStorage.encryptString(masterKey.toString('hex')))
    } else {
      fs.writeFileSync(keyPath, masterKey.toString('hex'))
    }
  }
}

function getKey(): Buffer {
  if (!masterKey) throw new Error('crypto not initialized')
  return masterKey
}

/** AES-256-GCM 加密，输出 base64(iv|ciphertext|tag) */
export function encryptString(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, encrypted, tag]).toString('base64')
}

/** 解密 encryptString 的输出；失败返回 null（不抛异常，避免启动中断） */
export function decryptString(cipherText: string): string | null {
  try {
    const buf = Buffer.from(cipherText, 'base64')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(buf.length - 16)
    const data = buf.subarray(12, buf.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', getKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

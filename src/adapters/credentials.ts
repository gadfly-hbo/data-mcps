/**
 * 凭据解析器接缝（PRD 架构分层；方案 §09）。
 * R1 实现：引用解析 + 会话内存语义 + 明确提示；Keychain 等系统存储仅留接口，不实现。
 * 硬规则：不扫描本机秘密、不读环境变量/文件、不落明文；浏览器不持有长期密钥。
 */

export interface CredentialResolution {
  ok: boolean;
  /** true = 本环境无系统凭据存储，解析仅会话内存（必须对用户明确提示） */
  sessionOnly: boolean;
  /** 需要展示给用户的提示；null = 无需提示 */
  notice: string | null;
}

export interface CredentialResolver {
  resolve(ref: string): CredentialResolution;
}

export class SessionMemoryCredentialResolver implements CredentialResolver {
  private readonly session = new Map<string, string>();

  resolve(ref: string): CredentialResolution {
    const r = ref.trim();
    if (!r) return { ok: false, sessionOnly: false, notice: "凭据引用为空" };
    if (r === "synthetic-none" || r.startsWith("synthetic://")) {
      return { ok: true, sessionOnly: false, notice: null }; // 合成源无需凭据
    }
    if (r.startsWith("keychain://")) {
      // 系统凭据存储本期未集成：引用只在会话内有效，且必须明确提示
      this.session.set(r, "session-placeholder");
      return { ok: true, sessionOnly: true, notice: "系统凭据存储不可用：该引用仅本会话内存解析；不落盘、不进浏览器载荷、不进日志" };
    }
    this.session.set(r, "session-placeholder");
    return { ok: true, sessionOnly: true, notice: "凭据仅按引用处理；本环境无系统存储集成，仅会话内存" };
  }

  /** 会话内已解析引用数（仅供审计/测试；永不导出值） */
  get sessionSize(): number {
    return this.session.size;
  }
}

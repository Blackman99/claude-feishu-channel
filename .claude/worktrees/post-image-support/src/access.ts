export interface AccessConfig {
  readonly allowedOpenIds: readonly string[];
  readonly unauthorizedBehavior: "ignore" | "reject";
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; action: "ignore" | "reject" };

export class AccessControl {
  private readonly whitelist: Set<string>;
  private readonly unauthorizedBehavior: "ignore" | "reject";

  constructor(config: AccessConfig) {
    this.whitelist = new Set(config.allowedOpenIds);
    this.unauthorizedBehavior = config.unauthorizedBehavior;
  }

  check(openId: string): AccessDecision {
    if (this.whitelist.has(openId)) return { allowed: true };
    return { allowed: false, action: this.unauthorizedBehavior };
  }
}

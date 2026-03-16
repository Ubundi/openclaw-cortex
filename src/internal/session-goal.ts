export interface SessionGoal {
  goal: string;
  setAt: string;
  setBy: "agent" | "user";
}

export class SessionGoalStore {
  private current: SessionGoal | undefined;

  get(): SessionGoal | undefined {
    return this.current;
  }

  set(goal: SessionGoal): void {
    this.current = goal;
  }

  clear(): void {
    this.current = undefined;
  }
}

export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
  ) {
    super(title)
  }

  toJSON() {
    return {
      type: `https://erp.avilaops.com/problems/${this.code}`,
      title: this.title,
      status: this.status,
    }
  }
}

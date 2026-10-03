// 坐标，直译自 chess-dike 的 gamelogic/Position.java
export class Position {
  constructor(
    public x: number,
    public y: number,
  ) {}

  equals(other: Position): boolean {
    return this.x === other.x && this.y === other.y
  }

  toString(): string {
    return `(${this.x}, ${this.y})`
  }
}

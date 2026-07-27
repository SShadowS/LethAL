export interface BuiltExpression {
  toAL(): string;
}

type ALBinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "div"
  | "mod"
  | "="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "and"
  | "or"
  | "xor";

type ALUnaryOp = "-" | "+" | "not";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const build = {
  booleanLiteral(value: boolean): BuiltExpression {
    return literal(value ? "true" : "false");
  },
  integerLiteral(value: number): BuiltExpression {
    if (!Number.isInteger(value)) throw new Error(`integerLiteral: ${value} is not an integer`);
    return literal(value.toString(10));
  },
  decimalLiteral(value: number): BuiltExpression {
    if (Number.isInteger(value)) return literal(`${value}.0`);
    return literal(value.toString(10));
  },
  textLiteral(value: string): BuiltExpression {
    return literal(`'${value.replace(/'/g, "''")}'`);
  },
  identifier(name: string): BuiltExpression {
    if (!IDENTIFIER.test(name))
      throw new Error(`identifier: "${name}" is not a valid AL identifier`);
    return literal(name);
  },
  binaryOp(op: ALBinaryOp, left: BuiltExpression, right: BuiltExpression): BuiltExpression {
    return literal(`${paren(left)} ${op} ${paren(right)}`);
  },
  unaryOp(op: ALUnaryOp, operand: BuiltExpression): BuiltExpression {
    if (op === "not") return literal(`not ${paren(operand)}`);
    return literal(`${op}${paren(operand)}`);
  },
  procedureCall(name: string, args: readonly BuiltExpression[]): BuiltExpression {
    if (!IDENTIFIER.test(name))
      throw new Error(`procedureCall: "${name}" is not a valid AL identifier`);
    const rendered = args.map((a) => a.toAL()).join(", ");
    return literal(`${name}(${rendered})`);
  },
  assignment(target: BuiltExpression, value: BuiltExpression): BuiltExpression {
    return literal(`${target.toAL()} := ${value.toAL()}`);
  },
} as const;

function literal(rendered: string): BuiltExpression {
  return {
    toAL() {
      return rendered;
    },
  };
}

function paren(expr: BuiltExpression): string {
  const rendered = expr.toAL();
  if (/\s/.test(rendered)) return `(${rendered})`;
  return rendered;
}

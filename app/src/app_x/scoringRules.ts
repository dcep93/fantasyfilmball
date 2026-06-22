export type ScoringPosition = {
  id: string;
  name: string;
  subtitle: string;
  formula: string;
};

export type ScoringRuleSet = {
  season: string;
  positions: ScoringPosition[];
  updatedAt: number;
};

export type MovieScoreInput = {
  A: number | null;
  B: number | null;
  G: number | null;
  R: number | null;
};

export const SCORE_INPUT_HELP =
  "G = domestic gross / $100M, B = budget / $100M, A = Letterboxd average, R = Letterboxd ratings / 100k.";

export function formatScoringFormula(formula: string) {
  if (formula === "150 * sqrt(G) * (A - 2)") {
    return "0.015 * sqrt(DOMESTIC_GROSS) * (LETTERBOXD_AVERAGE - 2)";
  }

  if (formula === "500 * sqrt(G) / (1 + B)") {
    return "5_000_000 * sqrt(DOMESTIC_GROSS) / (100_000_000 + PRODUCTION_BUDGET)";
  }

  if (formula === "126.5 * sqrt(R) / (1 + B)") {
    return "40_000_000 * sqrt(LETTERBOXD_RATING_COUNT) / (100_000_000 + PRODUCTION_BUDGET)";
  }

  if (formula === "1000 * sqrt(B) / (1 + A)") {
    return "0.1 * sqrt(PRODUCTION_BUDGET) / (1 + LETTERBOXD_AVERAGE)";
  }

  if (formula === "80 * (A - 3) * sqrt(R)") {
    return "0.25 * (LETTERBOXD_AVERAGE - 3) * sqrt(LETTERBOXD_RATING_COUNT)";
  }

  if (formula === "253 * (3 - A) * sqrt(R)") {
    return "0.8 * (3 - LETTERBOXD_AVERAGE) * sqrt(LETTERBOXD_RATING_COUNT)";
  }

  return formula
    .replace(/\bG\b/g, "(DOMESTIC_GROSS / 100_000_000)")
    .replace(/\bB\b/g, "(PRODUCTION_BUDGET / 100_000_000)")
    .replace(/\bA\b/g, "LETTERBOXD_AVERAGE")
    .replace(/\bR\b/g, "(LETTERBOXD_RATING_COUNT / 100_000)");
}

export const DEFAULT_SCORING_RULES: ScoringRuleSet = {
  season: "Summer 2026",
  updatedAt: 0,
  positions: [
    {
      id: "packed-house",
      name: "Packed House",
      subtitle: "Rewards high domestic gross and high Letterboxd average.",
      formula: "150 * sqrt(G) * (A - 2)",
    },
    {
      id: "budget-alchemy",
      name: "Budget Alchemy",
      subtitle: "Rewards high domestic gross without a high production budget.",
      formula: "500 * sqrt(G) / (1 + B)",
    },
    {
      id: "tiny-thunder",
      name: "Tiny Thunder",
      subtitle: "Rewards substantial Letterboxd rating volume despite low budget.",
      formula: "126.5 * sqrt(R) / (1 + B)",
    },
    {
      id: "disasterpiece",
      name: "Disasterpiece",
      subtitle: "Rewards low Letterboxd average with high production budget.",
      formula: "1000 * sqrt(B) / (1 + A)",
    },
    {
      id: "cult-furnace",
      name: "Cult Furnace",
      subtitle: "Rewards high Letterboxd average with substantial rating volume.",
      formula: "80 * (A - 3) * sqrt(R)",
    },
    {
      id: "rotten-crowd",
      name: "Rotten Crowd",
      subtitle: "Rewards low Letterboxd average with substantial rating volume.",
      formula: "253 * (3 - A) * sqrt(R)",
    },
  ],
};

type Token =
  | { type: "number"; value: number }
  | { type: "identifier"; value: string }
  | { type: "operator"; value: "+" | "-" | "*" | "/" }
  | { type: "paren"; value: "(" | ")" }
  | { type: "comma"; value: "," };

export function slugifyPosition(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "position"
  );
}

export function normalizeRuleSet(value: unknown): ScoringRuleSet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const season = typeof raw.season === "string" && raw.season.trim() ? raw.season : null;
  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : null;
  const positions = Array.isArray(raw.positions)
    ? raw.positions.map(normalizePosition).filter((position): position is ScoringPosition => Boolean(position))
    : [];

  if (!season || updatedAt === null || positions.length === 0) {
    return null;
  }

  return { positions, season, updatedAt };
}

function normalizePosition(value: unknown): ScoringPosition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null;
  const subtitle =
    typeof raw.subtitle === "string" && raw.subtitle.trim() ? raw.subtitle.trim() : null;
  const formula = typeof raw.formula === "string" && raw.formula.trim() ? raw.formula.trim() : null;
  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim()
      : name
        ? slugifyPosition(name)
        : null;

  if (!id || !name || !subtitle || !formula) {
    return null;
  }

  return { formula, id, name, subtitle };
}

export function evaluateFormula(formula: string, input: MovieScoreInput): number | null {
  try {
    const parser = new FormulaParser(tokenize(formula), input);
    const value = parser.parseExpression();
    parser.expectEnd();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < formula.length) {
    const char = formula[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let end = index + 1;
      while (end < formula.length && /[0-9.]/.test(formula[end])) {
        end += 1;
      }
      const value = Number(formula.slice(index, end));
      if (!Number.isFinite(value)) {
        throw new Error("Invalid number.");
      }
      tokens.push({ type: "number", value });
      index = end;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < formula.length && /[A-Za-z0-9_]/.test(formula[end])) {
        end += 1;
      }
      tokens.push({ type: "identifier", value: formula.slice(index, end) });
      index = end;
      continue;
    }

    if (char === "+" || char === "-" || char === "*" || char === "/") {
      tokens.push({ type: "operator", value: char });
      index += 1;
      continue;
    }

    if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char });
      index += 1;
      continue;
    }

    if (char === ",") {
      tokens.push({ type: "comma", value: "," });
      index += 1;
      continue;
    }

    throw new Error("Invalid formula character.");
  }

  return tokens;
}

class FormulaParser {
  private index = 0;
  private readonly input: MovieScoreInput;
  private readonly tokens: Token[];

  constructor(tokens: Token[], input: MovieScoreInput) {
    this.input = input;
    this.tokens = tokens;
  }

  parseExpression(): number {
    let value = this.parseTerm();

    while (this.matchOperator("+") || this.matchOperator("-")) {
      const operator = this.previous().value;
      const right = this.parseTerm();
      value = operator === "+" ? value + right : value - right;
    }

    return value;
  }

  expectEnd() {
    if (this.index !== this.tokens.length) {
      throw new Error("Unexpected token.");
    }
  }

  private parseTerm(): number {
    let value = this.parseFactor();

    while (this.matchOperator("*") || this.matchOperator("/")) {
      const operator = this.previous().value;
      const right = this.parseFactor();
      value = operator === "*" ? value * right : value / right;
    }

    return value;
  }

  private parseFactor(): number {
    if (this.matchOperator("-")) {
      return -this.parseFactor();
    }

    if (this.matchOperator("+")) {
      return this.parseFactor();
    }

    if (this.match("number")) {
      return this.previous().value as number;
    }

    if (this.match("identifier")) {
      const name = String(this.previous().value);

      if (this.matchParen("(")) {
        const args = [this.parseExpression()];
        while (this.match("comma")) {
          args.push(this.parseExpression());
        }
        this.consumeParen(")");
        return this.callFunction(name, args);
      }

      return this.variable(name);
    }

    if (this.matchParen("(")) {
      const value = this.parseExpression();
      this.consumeParen(")");
      return value;
    }

    throw new Error("Expected value.");
  }

  private variable(name: string): number {
    if (name !== "G" && name !== "B" && name !== "A" && name !== "R") {
      throw new Error("Unknown variable.");
    }

    const value = this.input[name];
    if (value === null) {
      throw new Error("Missing input.");
    }

    return value;
  }

  private callFunction(name: string, args: number[]): number {
    if (name === "sqrt" && args.length === 1) {
      return Math.sqrt(args[0]);
    }

    if (name === "abs" && args.length === 1) {
      return Math.abs(args[0]);
    }

    if (name === "log" && args.length === 1) {
      return Math.log(args[0]);
    }

    if (name === "log10" && args.length === 1) {
      return Math.log10(args[0]);
    }

    if (name === "min" && args.length === 2) {
      return Math.min(args[0], args[1]);
    }

    if (name === "max" && args.length === 2) {
      return Math.max(args[0], args[1]);
    }

    throw new Error("Unknown function.");
  }

  private match(type: Token["type"]) {
    if (this.peek()?.type !== type) {
      return false;
    }

    this.index += 1;
    return true;
  }

  private matchOperator(value: "+" | "-" | "*" | "/") {
    const token = this.peek();
    if (!token || token.type !== "operator" || token.value !== value) {
      return false;
    }

    this.index += 1;
    return true;
  }

  private matchParen(value: "(" | ")") {
    const token = this.peek();
    if (!token || token.type !== "paren" || token.value !== value) {
      return false;
    }

    this.index += 1;
    return true;
  }

  private consumeParen(value: "(" | ")") {
    if (!this.matchParen(value)) {
      throw new Error("Expected parenthesis.");
    }
  }

  private peek() {
    return this.tokens[this.index];
  }

  private previous() {
    return this.tokens[this.index - 1];
  }
}

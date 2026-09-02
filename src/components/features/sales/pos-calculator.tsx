"use client";

import {
  Calculator01Icon,
  DivideSignIcon,
  EqualSignIcon,
  MinusSignIcon,
  MultiplicationSignIcon,
  PercentIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useReducer } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { t } from "@/lib/utils";

// A plain pocket calculator staff can pop open from the New Sale header to
// work out change, split totals, apply a percentage, etc. It is a scratchpad
// only — it never writes to the cart or a sale. All arithmetic runs on
// numbers here (not money cents) because it is free-form mental math, not a
// business total; the checkout still re-derives every real total server-side.

type Operator = "+" | "-" | "*" | "/";

/** Calculator state — an immediate-execution (four-function) machine.
 *  `display` is the on-screen string; `accumulator` holds the running result
 *  once an operator is pressed; `pendingOp` is the operator awaiting its
 *  right-hand operand; `overwrite` means the next digit replaces the display
 *  (right after `=` or an operator). */
type CalcState = {
  display: string;
  accumulator: number | null;
  pendingOp: Operator | null;
  overwrite: boolean;
};

type CalcAction =
  | { type: "digit"; value: string }
  | { type: "decimal" }
  | { type: "operator"; value: Operator }
  | { type: "equals" }
  | { type: "percent" }
  | { type: "negate" }
  | { type: "backspace" }
  | { type: "clear" };

const INITIAL: CalcState = {
  display: "0",
  accumulator: null,
  pendingOp: null,
  overwrite: false,
};

/** Apply one binary operation. Division by zero yields NaN, surfaced to the
 *  user as an "Error" display rather than crashing. */
function compute(left: number, right: number, op: Operator): number {
  switch (op) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
  }
}

/** Trim floating-point noise (0.1 + 0.2) and keep the display readable. */
function formatResult(value: number): string {
  if (!Number.isFinite(value)) return "Error";
  // Round to 10 significant-ish digits, then drop trailing zeros.
  const rounded = Math.round(value * 1e10) / 1e10;
  return String(rounded);
}

function reducer(state: CalcState, action: CalcAction): CalcState {
  switch (action.type) {
    case "digit": {
      if (state.display === "Error") {
        return { ...INITIAL, display: action.value };
      }
      if (state.overwrite) {
        return { ...state, display: action.value, overwrite: false };
      }
      // Avoid leading zeros like "007".
      const next = state.display === "0" ? action.value : state.display + action.value;
      return { ...state, display: next };
    }

    case "decimal": {
      if (state.display === "Error") return { ...INITIAL, display: "0." };
      if (state.overwrite) return { ...state, display: "0.", overwrite: false };
      if (state.display.includes(".")) return state;
      return { ...state, display: state.display + "." };
    }

    case "operator": {
      const current = parseFloat(state.display);
      if (state.display === "Error" || Number.isNaN(current)) return state;
      // Chain operations: fold the pending op before storing the new one.
      if (state.pendingOp !== null && state.accumulator !== null && !state.overwrite) {
        const result = compute(state.accumulator, current, state.pendingOp);
        return {
          display: formatResult(result),
          accumulator: result,
          pendingOp: action.value,
          overwrite: true,
        };
      }
      return {
        ...state,
        accumulator: current,
        pendingOp: action.value,
        overwrite: true,
      };
    }

    case "equals": {
      if (state.pendingOp === null || state.accumulator === null) return state;
      const current = parseFloat(state.display);
      if (Number.isNaN(current)) return state;
      const result = compute(state.accumulator, current, state.pendingOp);
      return {
        display: formatResult(result),
        accumulator: null,
        pendingOp: null,
        overwrite: true,
      };
    }

    case "percent": {
      const current = parseFloat(state.display);
      if (Number.isNaN(current)) return state;
      // % of the running accumulator when mid-operation, else a plain /100.
      const base =
        state.accumulator !== null && state.pendingOp !== null
          ? (state.accumulator * current) / 100
          : current / 100;
      return { ...state, display: formatResult(base), overwrite: true };
    }

    case "negate": {
      if (state.display === "0" || state.display === "Error") return state;
      const next = state.display.startsWith("-")
        ? state.display.slice(1)
        : "-" + state.display;
      return { ...state, display: next };
    }

    case "backspace": {
      if (state.overwrite || state.display === "Error") return state;
      const trimmed = state.display.slice(0, -1);
      return {
        ...state,
        display: trimmed === "" || trimmed === "-" ? "0" : trimmed,
      };
    }

    case "clear":
      return INITIAL;
  }
}

export function PosCalculator() {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="outline" size="icon" aria-label={t().sales.calculator} />
        }
      >
        <HugeiconsIcon icon={Calculator01Icon} strokeWidth={2} className="size-4" />
      </DialogTrigger>
      <DialogContent className="max-w-xs gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <HugeiconsIcon
              icon={Calculator01Icon}
              strokeWidth={2}
              className="size-4 text-muted-foreground"
            />
            {t().sales.calculator}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t().sales.calculator}
          </DialogDescription>
        </DialogHeader>
        <CalculatorBody state={state} dispatch={dispatch} />
      </DialogContent>
    </Dialog>
  );
}

/** The display + keypad. Split out so the popup shell stays tiny and the
 *  keypad can also be reused elsewhere (e.g. embedded on a wide screen). */
function CalculatorBody({
  state,
  dispatch,
}: {
  state: CalcState;
  dispatch: React.Dispatch<CalcAction>;
}) {
  // Physical keyboard support while the popup is focused — numbers, operators,
  // Enter (=), Backspace, Escape (clear). Purely additive to the on-screen keys.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const { key } = event;
      if (key >= "0" && key <= "9") dispatch({ type: "digit", value: key });
      else if (key === ".") dispatch({ type: "decimal" });
      else if (key === "+" || key === "-" || key === "*" || key === "/")
        dispatch({ type: "operator", value: key });
      else if (key === "Enter" || key === "=") {
        event.preventDefault();
        dispatch({ type: "equals" });
      } else if (key === "%") dispatch({ type: "percent" });
      else if (key === "Backspace") dispatch({ type: "backspace" });
      else if (key === "Escape") dispatch({ type: "clear" });
      else return;
      event.stopPropagation();
    },
    [dispatch],
  );

  return (
    <div
      className="flex flex-col gap-3 outline-none"
      role="group"
      aria-label={t().sales.calculator}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <output
        className="block w-full truncate rounded-md border bg-muted px-3 py-3 text-right font-mono text-2xl font-semibold tabular-nums"
        aria-live="polite"
      >
        {state.display}
      </output>

      <div className="grid grid-cols-4 gap-2">
        {/* Row 1: Clear, ±, %, ÷ */}
        <Button
          type="button"
          variant="secondary"
          className="h-12 text-sm"
          onClick={() => dispatch({ type: "clear" })}
        >
          {t().sales.calculatorClear}
        </Button>
        <CalcKey label="±" onClick={() => dispatch({ type: "negate" })} />
        <CalcKey icon={PercentIcon} onClick={() => dispatch({ type: "percent" })} />
        <CalcKey
          icon={DivideSignIcon}
          variant="secondary"
          onClick={() => dispatch({ type: "operator", value: "/" })}
        />

        {/* Row 2: 7 8 9 × */}
        <CalcKey label="7" onClick={() => dispatch({ type: "digit", value: "7" })} />
        <CalcKey label="8" onClick={() => dispatch({ type: "digit", value: "8" })} />
        <CalcKey label="9" onClick={() => dispatch({ type: "digit", value: "9" })} />
        <CalcKey
          icon={MultiplicationSignIcon}
          variant="secondary"
          onClick={() => dispatch({ type: "operator", value: "*" })}
        />

        {/* Row 3: 4 5 6 − */}
        <CalcKey label="4" onClick={() => dispatch({ type: "digit", value: "4" })} />
        <CalcKey label="5" onClick={() => dispatch({ type: "digit", value: "5" })} />
        <CalcKey label="6" onClick={() => dispatch({ type: "digit", value: "6" })} />
        <CalcKey
          icon={MinusSignIcon}
          variant="secondary"
          onClick={() => dispatch({ type: "operator", value: "-" })}
        />

        {/* Row 4: 1 2 3 + */}
        <CalcKey label="1" onClick={() => dispatch({ type: "digit", value: "1" })} />
        <CalcKey label="2" onClick={() => dispatch({ type: "digit", value: "2" })} />
        <CalcKey label="3" onClick={() => dispatch({ type: "digit", value: "3" })} />
        <CalcKey
          icon={PlusSignIcon}
          variant="secondary"
          onClick={() => dispatch({ type: "operator", value: "+" })}
        />

        {/* Row 5: 0 (wide), ., ⌫/= */}
        <CalcKey
          label="0"
          className="col-span-2"
          onClick={() => dispatch({ type: "digit", value: "0" })}
        />
        <CalcKey label="." onClick={() => dispatch({ type: "decimal" })} />
        <CalcKey
          icon={EqualSignIcon}
          variant="default"
          onClick={() => dispatch({ type: "equals" })}
        />
      </div>
    </div>
  );
}

/** One keypad button — either a text label (digits, ., ±) or a hugeicon
 *  (operators). Defaults to the outline variant so digits read as neutral. */
function CalcKey({
  label,
  icon,
  variant = "outline",
  className,
  onClick,
}: {
  label?: string;
  icon?: typeof PlusSignIcon;
  variant?: "default" | "secondary" | "outline";
  className?: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      className={"h-12 text-lg font-medium tabular-nums " + (className ?? "")}
      aria-label={label}
      onClick={onClick}
    >
      {icon ? (
        <HugeiconsIcon icon={icon} strokeWidth={2} className="size-5" />
      ) : (
        label
      )}
    </Button>
  );
}

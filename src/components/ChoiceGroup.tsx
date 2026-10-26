import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { KeyboardEvent } from "react";

/** One typed option and its local artwork, visible label and accessible description. */
export interface Choice<Value extends string = string> {
  value: Value;
  title: string;
  description: string;
  image: string;
}
interface ChoiceGroupProps<Value extends string> {
  label: string;
  value: Value | "";
  choices: Choice<Value>[];
  onChange(value: Value): void;
  kind?: "workspace" | "appearance" | "agent";
  disabled?: boolean;
}

/** Offer unboxed, fully labelled choices using shadcn's arrow-key and Space-enabled radio group. */
export function ChoiceGroup<Value extends string>({
  label,
  value,
  choices,
  onChange,
  kind = "workspace",
  disabled,
}: ChoiceGroupProps<Value>) {
  /** Accept only values rendered by this group, preserving enum types across the primitive boundary. */
  function selectChoice(value: string) {
    const choice = choices.find((item) => item.value === value);
    if (choice) onChange(choice.value);
  }
  /** Select on keydown so quick key releases cannot race Radix's delayed focus-based selection. */
  function selectWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target;
    if (
      disabled ||
      !(target instanceof HTMLElement) ||
      target.getAttribute("role") !== "radio"
    )
      return;
    const keys = [
      "ArrowRight",
      "ArrowDown",
      "ArrowLeft",
      "ArrowUp",
      "Home",
      "End",
    ];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const current = choices.findIndex(
      (choice) => choice.value === target.getAttribute("value"),
    );
    const direction = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
    if (current < 0 || choices.length === 0) return;
    let index = (current + direction + choices.length) % choices.length;
    if (event.key === "Home") index = 0;
    if (event.key === "End") index = choices.length - 1;
    const next = choices[index].value;
    onChange(next);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[role="radio"][value="${next}"]`)
      ?.focus();
  }

  return (
    <RadioGroup
      className={`choices choices-${kind}`}
      aria-label={label}
      value={value}
      onValueChange={selectChoice}
      disabled={disabled}
      onKeyDownCapture={selectWithKeyboard}
    >
      {choices.map((choice) => (
        <label
          className="choice"
          key={choice.value}
          htmlFor={`choice-${choice.value}`}
          data-selected={choice.value === value}
        >
          <img
            className="choice-image"
            src={`/assets/onboarding/${choice.image}`}
            alt=""
            draggable="false"
          />
          <span className="choice-title" id={`title-${choice.value}`}>
            {choice.title}
          </span>
          <span
            className="choice-description"
            id={`description-${choice.value}`}
          >
            {choice.description}
          </span>
          <RadioGroupItem
            value={choice.value}
            id={`choice-${choice.value}`}
            className="choice-radio"
            aria-labelledby={`title-${choice.value}`}
            aria-describedby={`description-${choice.value}`}
          />
        </label>
      ))}
    </RadioGroup>
  );
}

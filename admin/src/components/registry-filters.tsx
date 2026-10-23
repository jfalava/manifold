import { Button, Combobox, cn } from "@cloudflare/kumo";
import { CheckIcon, MagnifyingGlassIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import {
  EMPTY_REGISTRY_FILTERS,
  registryFilterLabel,
  type RegistryFilters,
} from "../lib/registry-filters";

type FilterKind = "status" | "has" | "missing" | "unlinked";
type FilterOption = { readonly kind: FilterKind; readonly value: string; readonly label: string };

const FIELDS = [
  { value: "all", label: "All" },
  { value: "status", label: "Status" },
  { value: "has", label: "Has binding" },
  { value: "missing", label: "Missing binding" },
] as const;

export function RegistryFilterBar({
  filters,
  statuses,
  providers,
  onChange,
}: {
  readonly filters: RegistryFilters;
  readonly statuses: readonly string[];
  readonly providers: readonly string[];
  readonly onChange: (filters: RegistryFilters) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<FilterKind | "all">("all");
  const [query, setQuery] = useState("");
  const bar = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const options = useMemo<FilterOption[]>(
    () => [
      ...statuses.map((value): FilterOption => ({
        kind: "status",
        value,
        label: `Status: ${registryFilterLabel(value)}`,
      })),
      ...providers.flatMap((value): FilterOption[] => [
        { kind: "has", value, label: `Has: ${registryFilterLabel(value)}` },
        { kind: "missing", value, label: `Missing: ${registryFilterLabel(value)}` },
      ]),
      { kind: "unlinked", value: "unlinked", label: "Bindings: None" },
    ],
    [statuses, providers],
  );
  const visibleOptions = options.filter((option) => field === "all" || option.kind === field);

  function edit(kind: FilterKind | "all") {
    setField(kind);
    setQuery("");
    setOpen(true);
    input.current?.focus();
  }

  function select(option: FilterOption | null) {
    if (!option) {
      return;
    }
    const text = query === "" ? filters.text : "";
    if (option.kind === "status") {
      onChange({
        ...filters,
        text,
        statuses: filters.statuses.includes(option.value)
          ? filters.statuses.filter((value) => value !== option.value)
          : [...filters.statuses, option.value],
      });
    } else if (option.kind === "unlinked") {
      onChange({ ...filters, text, unlinked: !filters.unlinked });
    } else {
      const binding = { provider: option.value, present: option.kind === "has" };
      const existing = filters.bindings.find((item) => item.provider === option.value);
      onChange({
        ...filters,
        text,
        bindings: existing
          ? filters.bindings.flatMap((item) =>
              item.provider !== option.value
                ? [item]
                : item.present === binding.present
                  ? []
                  : [binding],
            )
          : [...filters.bindings, binding],
      });
    }
    setQuery("");
    setOpen(false);
    input.current?.focus();
  }

  function selected(option: FilterOption): boolean {
    if (option.kind === "status") {
      return filters.statuses.includes(option.value);
    }
    if (option.kind === "unlinked") {
      return filters.unlinked;
    }
    return filters.bindings.some(
      (item) => item.provider === option.value && item.present === (option.kind === "has"),
    );
  }

  function disabledReason(option: FilterOption): string | undefined {
    if (option.kind === "has" && filters.unlinked) {
      return "Remove Bindings: None first";
    }
    if (option.kind === "unlinked" && filters.bindings.some((item) => item.present)) {
      return "Remove Has binding filters first";
    }
    return undefined;
  }

  const pills = [
    ...(filters.statuses.length
      ? [
          {
            key: "status",
            label: `Status: ${filters.statuses.map(registryFilterLabel).join(" or ")}`,
            kind: "status" as const,
            remove: () => onChange({ ...filters, statuses: [] }),
          },
        ]
      : []),
    ...filters.bindings.map((binding) => ({
      key: binding.provider,
      label: `${binding.present ? "Has" : "Missing"}: ${registryFilterLabel(binding.provider)}`,
      kind: binding.present ? ("has" as const) : ("missing" as const),
      remove: () =>
        onChange({
          ...filters,
          bindings: filters.bindings.filter((item) => item.provider !== binding.provider),
        }),
    })),
    ...(filters.unlinked
      ? [
          {
            key: "unlinked",
            label: "Bindings: None",
            kind: "unlinked" as const,
            remove: () => onChange({ ...filters, unlinked: false }),
          },
        ]
      : []),
  ];

  return (
    <div className="grid gap-2">
      <label htmlFor="registry-search" className="text-sm font-medium">
        Search and filters
      </label>
      <Combobox<FilterOption>
        items={visibleOptions}
        value={null}
        onValueChange={select}
        open={open}
        onOpenChange={setOpen}
        inputValue={filters.text}
        onInputValueChange={(value, details) => {
          // The combobox clears its unselected query on dismissal; registry text is a filter.
          if (details.reason === "input-change") {
            setQuery(value);
            setField("all");
            onChange({ ...filters, text: value });
          }
        }}
        filter={(option) => option.label.toLowerCase().includes(query.toLowerCase())}
        itemToStringLabel={(option) => option.label}
      >
        <div
          ref={bar}
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-kumo-line bg-kumo-base p-2 focus-within:ring-2 focus-within:ring-kumo-brand"
        >
          <MagnifyingGlassIcon
            className="ml-1 size-5 shrink-0 text-kumo-subtle"
            aria-hidden="true"
          />
          {pills.map((pill, index) => (
            <div key={pill.key} className="flex min-w-0 items-center gap-2">
              {index > 0 && (
                <span aria-hidden="true" className="text-[10px] font-medium text-kumo-subtle">
                  AND
                </span>
              )}
              <div
                className={cn(
                  "flex min-w-0 items-center rounded-full border text-sm",
                  pill.kind === "status"
                    ? "border-kumo-info/25 bg-kumo-info-tint text-kumo-info"
                    : pill.kind === "missing"
                      ? "border-kumo-warning/25 bg-kumo-warning-tint text-kumo-warning"
                      : "border-kumo-line bg-kumo-fill text-kumo-default",
                )}
              >
                <button
                  type="button"
                  data-registry-pill
                  className="min-h-11 min-w-0 rounded-l-full py-1 pr-1 pl-3 text-left break-words outline-offset-2 focus-visible:outline-2 sm:min-h-9"
                  aria-label={`Edit ${pill.label}`}
                  onClick={() => edit(pill.kind)}
                  onKeyDown={(event) => {
                    if (event.key === "Backspace" || event.key === "Delete") {
                      event.preventDefault();
                      pill.remove();
                      input.current?.focus();
                    }
                  }}
                >
                  {pill.label}
                </button>
                <button
                  type="button"
                  className="flex min-h-11 w-11 shrink-0 items-center justify-center rounded-r-full hover:bg-kumo-fill-hover focus-visible:outline-2 sm:min-h-9 sm:w-9"
                  aria-label={`Remove ${pill.label}`}
                  onClick={() => {
                    pill.remove();
                    input.current?.focus();
                  }}
                >
                  <XIcon className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
          {pills.length > 0 && filters.text !== "" && (
            <span aria-hidden="true" className="text-[10px] font-medium text-kumo-subtle">
              AND
            </span>
          )}
          <Combobox.Input
            ref={input}
            id="registry-search"
            aria-label="Search and filters"
            placeholder={
              pills.length ? "Search titles or IDs…" : "Search titles or IDs, add filters…"
            }
            className="m-0! h-auto! min-h-11 w-auto! min-w-40 flex-1 border-0! bg-transparent! px-1! text-kumo-default shadow-none! ring-0! outline-none placeholder:text-kumo-subtle sm:min-h-9"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && filters.text === "" && !open) {
                event.preventDefault();
                edit("all");
              }
              if (event.key === "Backspace" && filters.text === "") {
                const buttons =
                  bar.current?.querySelectorAll<HTMLButtonElement>("[data-registry-pill]");
                buttons?.[buttons.length - 1]?.focus();
              }
            }}
          />
          <Combobox.Trigger
            render={<Button variant="secondary" className="min-h-11 shrink-0 sm:min-h-9" />}
            onClick={() => {
              setField("all");
              setQuery("");
            }}
          >
            <PlusIcon className="size-4" aria-hidden="true" /> Filter
          </Combobox.Trigger>
          <Combobox.Content className="z-30 w-80 min-w-0" align="end">
            <section aria-label="Filter conditions" className="flex min-h-0 flex-col">
              <div className="px-3 pt-1 pb-2 text-sm font-medium">Add a condition</div>
              <div className="flex flex-wrap gap-1 border-b border-kumo-line px-2 pb-2">
                {FIELDS.map((item) => (
                  <Button
                    key={item.value}
                    size="sm"
                    className="min-h-11 min-w-11 sm:min-h-8"
                    variant={field === item.value ? "secondary" : "ghost"}
                    aria-pressed={field === item.value}
                    onClick={() => {
                      setField(item.value);
                      setQuery("");
                    }}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
              <Combobox.List>
                {(option: FilterOption) => (
                  <Combobox.Item
                    key={`${option.kind}:${option.value}`}
                    value={option}
                    aria-label={`${option.label}${selected(option) ? " (selected)" : ""}${disabledReason(option) ? ` — ${disabledReason(option)}` : ""}`}
                    disabled={disabledReason(option) !== undefined}
                  >
                    <div className="flex min-h-8 items-center gap-2">
                      <CheckIcon
                        aria-hidden="true"
                        className={cn("size-4 shrink-0", !selected(option) && "invisible")}
                      />
                      <div>
                        <div>{option.label}</div>
                        {disabledReason(option) ? (
                          <div className="text-xs">{disabledReason(option)}</div>
                        ) : (option.kind === "has" || option.kind === "missing") &&
                          filters.bindings.some(
                            (binding) =>
                              binding.provider === option.value &&
                              binding.present !== (option.kind === "has"),
                          ) ? (
                          <div className="text-xs text-kumo-subtle">
                            Replaces the current condition
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </Combobox.Item>
                )}
              </Combobox.List>
              <Combobox.Empty>No matching filters. Text searches titles and IDs.</Combobox.Empty>
              <div className="border-t border-kumo-line px-3 pt-2 text-xs text-kumo-subtle">
                {field === "status"
                  ? "Selected statuses match with OR. Select again to remove."
                  : "Conditions combine with AND. Has means a binding exists."}
              </div>
            </section>
          </Combobox.Content>
          {(pills.length > 0 || filters.text !== "") && (
            <Button
              variant="ghost"
              className="min-h-11 sm:min-h-9"
              onClick={() => {
                onChange(EMPTY_REGISTRY_FILTERS);
                setQuery("");
                setOpen(false);
                input.current?.focus();
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
      </Combobox>
    </div>
  );
}

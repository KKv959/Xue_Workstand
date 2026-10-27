"use client";

import { useMemo } from "react";
import { Button, Dialog, DialogTrigger } from "react-aria-components";
import { WorkbenchSelectPopover } from "@/components/WorkbenchSelect";
import { Check, ChevronDown, Plus } from "lucide-react";
import { formatPlatform } from "@/components/Formatters";
import { writeStyleReferenceKey } from "@/lib/write-references";
import type { AccountListItem, WriteStyleReferenceInput } from "@/lib/types";

type WriterReferencePickerProps = {
  accounts: AccountListItem[];
  disabled?: boolean;
  onChange: (references: WriteStyleReferenceInput[]) => void;
  references: WriteStyleReferenceInput[];
  /** add：触发器显示为“加风格卡”，已选风格由外部卡片展示。 */
  variant?: "summary" | "add";
};

type ReferenceOption = {
  key: string;
  label: string;
  meta: string;
  unavailable: boolean;
  reference: WriteStyleReferenceInput;
};

const MAX_CONCURRENT_STYLES = 8;

export function WriterReferencePicker({
  variant = "summary",
  accounts,
  disabled,
  onChange,
  references
}: WriterReferencePickerProps) {
  const options = useMemo<ReferenceOption[]>(() => [
    ...accounts.map((account) => ({
      key: writeStyleReferenceKey({ targetType: "account", platform: account.platform, accountId: account.id }),
      label: account.name,
      meta: account.styleStatus === "not_generated" ? "风格卡未生成 · 先到资料库生成" : `${formatPlatform(account.platform)}账号`,
      unavailable: account.styleStatus === "not_generated",
      reference: { targetType: "account" as const, platform: account.platform, accountId: account.id }
    }))
  ], [accounts]);
  const selectedKeys = useMemo(() => references.map(writeStyleReferenceKey), [references]);
  const selectedOptions = selectedKeys.flatMap((key) => {
    const option = options.find((item) => item.key === key);
    return option ? [option] : [];
  });
  const summary = selectedOptions.length > 1
    ? `已选 ${selectedOptions.length} 个风格 · 分别生成`
    : selectedOptions[0]?.label || "选择参考风格";

  const toggleReference = (option: ReferenceOption) => {
    const accountReferences = references.filter((reference) => reference.targetType === "account");
    const selected = selectedKeys.includes(option.key);
    if (selected && accountReferences.length === 1) return;
    if (!selected && accountReferences.length >= MAX_CONCURRENT_STYLES) return;
    onChange(selected
      ? accountReferences.filter((reference) => writeStyleReferenceKey(reference) !== option.key)
      : [...accountReferences, option.reference]);
  };

  const renderGroup = (label: string, group: ReferenceOption[]) => group.length ? (
    <section className="writer-reference-picker-group">
      <strong>{label}</strong>
      {group.map((option) => {
        const selected = selectedKeys.includes(option.key);
        return (
          <button
            aria-selected={selected}
            className={`writer-reference-option ${option.unavailable ? "is-unavailable" : ""}`}
            disabled={option.unavailable ? !selected : !selected && references.filter((reference) => reference.targetType === "account").length >= MAX_CONCURRENT_STYLES}
            key={option.key}
            onClick={() => toggleReference(option)}
            role="option"
            title={option.unavailable ? "风格卡还是占位内容，先在资料库生成" : undefined}
            type="button"
          >
            <span className={`writer-reference-check ${selected ? "selected" : ""}`} aria-hidden="true">
              {selected ? <Check size={13} /> : null}
            </span>
            <span className="writer-reference-option-copy">
              <span>{option.label}</span>
              <small>{option.meta}</small>
            </span>
            {selected ? <em>独立成稿</em> : null}
          </button>
        );
      })}
    </section>
  ) : null;

  return (
    <div className="writer-reference-picker">
      <DialogTrigger>
        {variant === "add" ? (
          <Button
            aria-label={`调整参考风格，已选 ${selectedOptions.length} 个`}
            className="writer-reference-picker-trigger is-add"
            isDisabled={disabled}
            type="button"
          >
            <Plus aria-hidden="true" size={15} />
            <span>{selectedOptions.length ? "加 / 换风格卡" : "选择参考风格"}</span>
          </Button>
        ) : (
          <Button
            aria-label="选择参考风格"
            className="writer-reference-picker-trigger"
            isDisabled={disabled}
            type="button"
          >
            <span>{summary}</span>
            {selectedOptions.length > 1 ? <small>{selectedOptions.length}</small> : null}
            <ChevronDown aria-hidden="true" size={15} />
          </Button>
        )}
        <WorkbenchSelectPopover placement="bottom start" offset={6}>
          <Dialog aria-label="选择参考风格" className="writer-reference-menu">
            <div aria-label="账号风格" aria-multiselectable="true" role="listbox">
              {renderGroup("账号风格", options.filter((option) => option.reference.targetType === "account"))}
            </div>
            <p>最多选 8 个账号，每个风格单独生成一篇。</p>
          </Dialog>
        </WorkbenchSelectPopover>
      </DialogTrigger>
    </div>
  );
}

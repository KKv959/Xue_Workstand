"use client";

import { Children, isValidElement, type ReactNode } from "react";
import { Button, I18nProvider, ListBox, ListBoxItem, Popover, PopoverContext, Select, SelectValue, useSlottedContext, type PopoverProps } from "react-aria-components";
import { Check, ChevronDown } from "lucide-react";

type Props = {
  children: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  name?: string;
  "aria-label": string;
  "aria-describedby"?: string;
};

export function WorkbenchSelect({ children, value, onValueChange, disabled, className = "", id, name, ...aria }: Props) {
  const options = Children.toArray(children).filter(isValidElement<{ value?: string; children: ReactNode; disabled?: boolean }>).map(option => ({
    value: option.props.value ?? Children.toArray(option.props.children).join(""),
    label: Children.toArray(option.props.children).join(""),
    disabled: option.props.disabled
  }));
  return (
    <I18nProvider locale="zh-CN">
      <Select {...aria} className="workbench-select" name={name} value={value} onChange={key => onValueChange(String(key ?? ""))} isDisabled={disabled || !options.length}>
        <Button className={`workbench-select-trigger ${className}`} id={id}>
          <SelectValue className="workbench-select-value" />
          <ChevronDown aria-hidden="true" size={14} />
        </Button>
        <WorkbenchSelectPopover placement="bottom start" offset={6}>
          <ListBox className="workbench-select-options" items={options}>
            {option => <ListBoxItem id={option.value} textValue={option.label} isDisabled={option.disabled} className="workbench-select-option">
              {({ isSelected }) => <><span>{option.label}</span>{isSelected ? <Check aria-hidden="true" size={14} /> : null}</>}
            </ListBoxItem>}
          </ListBox>
        </WorkbenchSelectPopover>
      </Select>
    </I18nProvider>
  );
}

export function WorkbenchSelectPopover(props: PopoverProps) {
  const context = useSlottedContext(PopoverContext);
  return <Popover {...props} className="workbench-select-popover" style={() => {
    const trigger = context?.triggerRef?.current;
    // 浮层通过 portal 挂在 body 下，需要显式沿用触发框的实际字号。
    return trigger ? { fontSize: getComputedStyle(trigger).fontSize } : {};
  }} />;
}

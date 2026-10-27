"use client";

import { useState } from "react";
import { getLocalTimeZone, parseDate, today } from "@internationalized/date";
import { Button, CalendarCell, CalendarGrid, CalendarGridBody, CalendarGridHeader, CalendarHeaderCell, Dialog, DialogTrigger, Heading, I18nProvider, Popover, RangeCalendar } from "react-aria-components";
import { CalendarRange, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

export function MonitorDateFilter({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const [open, setOpen] = useState(false);
  const rangeLabel = from || to ? `${from || "不限"} → ${to || "不限"}` : "不限日期";
  const compactLabel = from || to ? `${from?.slice(5) || "不限"}–${to?.slice(5) || "不限"}` : "日期";
  const selectRange = (start: string, end: string) => { onChange(start, end); setOpen(false); };
  return (
    <I18nProvider locale="zh-CN">
      <div className="gross-monitor-date-range" title={`发布日期：${rangeLabel}`}>
        <DialogTrigger isOpen={open} onOpenChange={setOpen}>
          <Button className="workbench-select-trigger gross-monitor-date-trigger" aria-label={`按发布日期筛选：${rangeLabel}`}>
            <CalendarRange aria-hidden="true" size={16} />
            <span>{compactLabel}</span>
            <ChevronDown aria-hidden="true" size={14} />
          </Button>
          <Popover className="workbench-select-popover gross-monitor-calendar-popover" placement="bottom end" offset={6}>
            <Dialog aria-label="选择发布日期范围" className="gross-monitor-calendar-dialog">
              <div className="gross-monitor-calendar-presets">
                {[7, 30].map(days => <Button className="btn subtle compact" key={days} onPress={() => {
                  const end = today(getLocalTimeZone());
                  selectRange(end.subtract({ days: days - 1 }).toString(), end.toString());
                }}>近 {days} 天</Button>)}
                <Button className="btn subtle compact" onPress={() => {
                  const end = today(getLocalTimeZone());
                  selectRange(end.set({ day: 1 }).toString(), end.toString());
                }}>本月</Button>
              </div>
              <RangeCalendar aria-label="发布日期范围" value={from && to && from <= to ? { start: parseDate(from), end: parseDate(to) } : null}
                defaultFocusedValue={from ? parseDate(from) : undefined}
                onChange={range => selectRange(range.start.toString(), range.end.toString())}>
                <header className="gross-monitor-calendar-header">
                  <Button slot="previous" className="btn icon-only compact" aria-label="上个月"><ChevronLeft aria-hidden="true" size={16} /></Button>
                  <Heading />
                  <Button slot="next" className="btn icon-only compact" aria-label="下个月"><ChevronRight aria-hidden="true" size={16} /></Button>
                </header>
                <CalendarGrid weekdayStyle="short">
                  <CalendarGridHeader>{day => <CalendarHeaderCell>{day}</CalendarHeaderCell>}</CalendarGridHeader>
                  <CalendarGridBody>{date => <CalendarCell date={date} className="gross-monitor-calendar-day" />}</CalendarGridBody>
                </CalendarGrid>
              </RangeCalendar>
              <footer className="gross-monitor-calendar-footer">
                <span>先选开始日期，再选结束日期</span>
                <Button className="btn subtle compact" onPress={() => selectRange("", "")}>不限日期</Button>
              </footer>
            </Dialog>
          </Popover>
        </DialogTrigger>
      </div>
    </I18nProvider>
  );
}

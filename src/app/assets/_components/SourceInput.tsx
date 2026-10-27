"use client";

type SourceInputProps = {
  value: string;
  onChange: (value: string) => void;
};

export function SourceInput({ value, onChange }: SourceInputProps) {
  return (
    <section className="engagement-form-section engagement-source-panel">
      <div className="engagement-form-heading">
        <h3>输入内容</h3>
      </div>
      <label className="field">
        <span>链接或文案</span>
        <textarea
          autoComplete="off"
          className="engagement-textarea engagement-source-input"
          name="engagementSource"
          placeholder="粘贴视频链接或直接粘贴文案，链接会先转写，文案直接生成…"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    </section>
  );
}

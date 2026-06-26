type YearSelectorToolbarProps = {
  count: number;
  onChange: (year: string) => void;
  value: string;
  years: string[];
};

export function YearSelectorToolbar({ count, onChange, value, years }: YearSelectorToolbarProps) {
  return (
    <div className="ffb-year-toolbar">
      <label>
        Year
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {years.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>
      </label>
      <span>{count} films loaded</span>
    </div>
  );
}

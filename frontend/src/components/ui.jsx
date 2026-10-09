import React from 'react';

export const Panel = ({ title, hint, action, children, className = '', testId }) => (
  <section
    data-testid={testId}
    className={`rounded-sm border border-ink-600/70 bg-ink-800/70 shadow-panel backdrop-blur-[2px] ${className}`}
  >
    {(title || action) && (
      <header className="flex items-start justify-between gap-4 border-b border-ink-600/70 px-5 py-3">
        <div>
          <h2 className="font-display text-base md:text-lg tracking-tight text-bone">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
        </div>
        {action}
      </header>
    )}
    <div className="px-5 py-4">{children}</div>
  </section>
);

const VARIANTS = {
  primary: 'bg-amarelo text-ink-900 hover:bg-[#e9b529] border-amarelo',
  solid: 'bg-ink-600 text-bone hover:bg-ink-500 border-ink-500',
  ghost: 'bg-transparent text-bone hover:bg-ink-700 border-ink-600',
  danger: 'bg-transparent text-sangue hover:bg-sangue/10 border-sangue/60',
};

export const Button = ({ variant = 'solid', className = '', ...props }) => (
  <button
    {...props}
    className={`inline-flex items-center justify-center gap-2 rounded-sm border px-3.5 py-2 font-mono text-xs uppercase tracking-[0.12em] transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
  />
);

export const Field = ({ label, hint, ...props }) => (
  <label className="block">
    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{label}</span>
    <input
      {...props}
      className="mt-1.5 w-full rounded-sm border border-ink-600 bg-ink-900/80 px-3 py-2 text-sm text-bone outline-none transition-colors duration-200 placeholder:text-ink-500 focus:border-amarelo"
    />
    {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
  </label>
);

export const Stat = ({ label, value, unit, testId }) => (
  <div data-testid={testId} className="border-l-2 border-ink-600 pl-3">
    <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{label}</div>
    <div className="mt-0.5 font-display text-xl text-bone">
      {value}
      {unit && <span className="ml-1 font-mono text-xs text-muted">{unit}</span>}
    </div>
  </div>
);

const TONES = {
  neutral: 'border-ink-500 text-muted',
  good: 'border-verde/60 text-verde',
  warn: 'border-amarelo/60 text-amarelo',
  bad: 'border-sangue/60 text-sangue',
  info: 'border-azul/60 text-azul',
};

export const Badge = ({ tone = 'neutral', children, testId }) => (
  <span
    data-testid={testId}
    className={`inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] ${TONES[tone]}`}
  >
    {children}
  </span>
);

export const Empty = ({ children }) => (
  <p className="py-6 text-center font-mono text-xs text-muted">{children}</p>
);

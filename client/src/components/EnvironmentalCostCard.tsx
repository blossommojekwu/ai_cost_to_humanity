import React from 'react';
import { EnvironmentalCost } from '../types';

interface EnvironmentalCostCardProps {
  cost: EnvironmentalCost;
}

const format = (value: number | null, maxDigits: number): string =>
  value === null ? 'n/a' : value.toLocaleString(undefined, { maximumFractionDigits: maxDigits });

export default function EnvironmentalCostCard({ cost }: EnvironmentalCostCardProps): React.ReactElement {
  const measured =
    cost.basis === 'tokens'
      ? `${cost.measured.toLocaleString()} input tokens${cost.measuredIsEstimate ? ' (estimated)' : ''}`
      : `${cost.measured.toLocaleString()} words`;

  const metrics = [
    {
      label: 'Energy',
      value: format(cost.energyWh, 3),
      unit: 'Wh',
      extra: cost.energyWh !== null && cost.energySdWh !== null ? `± ${format(cost.energySdWh, 3)}` : '',
    },
    { label: 'Water', value: format(cost.waterMl, 2), unit: 'mL', extra: '' },
    { label: 'Carbon', value: format(cost.carbonGCO2e, 2), unit: 'gCO₂e', extra: '' },
  ];

  return (
    <div className="mt-3 bg-white rounded-lg p-3 border border-emerald-300 text-gray-800">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-sm">Environmental cost of this prompt</div>
        <div className="text-xs text-emerald-700 bg-emerald-50 rounded px-2 py-0.5 whitespace-nowrap">
          {cost.modelLabel}
          {cost.isDefault ? ' · default' : ''}
        </div>
      </div>

      <div className="text-xs text-gray-500 mt-1">
        {measured} → <span className="font-medium">{cost.size}</span> prompt (benchmark: ~
        {cost.assumedInputTokens.toLocaleString()} input + {cost.assumedOutputTokens.toLocaleString()} output tokens)
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3">
        {metrics.map((m) => (
          <div key={m.label} className="bg-emerald-50 rounded p-2 text-center">
            <div className="text-xs text-gray-600">{m.label}</div>
            <div className="text-lg font-semibold">{m.value}</div>
            <div className="text-xs text-gray-500">
              {m.unit}
              {m.extra ? ` ${m.extra}` : ''}
            </div>
          </div>
        ))}
      </div>

      {cost.note && (
        <div className="mt-2 text-xs text-amber-800 bg-amber-50 rounded p-2">{cost.note}</div>
      )}
    </div>
  );
}

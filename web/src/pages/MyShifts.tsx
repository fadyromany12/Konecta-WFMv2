import { Route, Routes } from 'react-router-dom';
import { SubTabs } from '../App';
import { Absence } from './Absence';
import { ExtraHours, Swaps } from './SelfService';

/**
 * Everything an advisor arranges about their own time, and the approvals that
 * go with it: time off, swapping a shift with a colleague, and bidding for
 * extra hours.
 */
export function MyShifts() {
  return (
    <>
      <SubTabs
        items={[
          { to: '/my', label: 'Time Off' },
          { to: '/my/swaps', label: 'Shift Swaps' },
          { to: '/my/extra-hours', label: 'Extra Hours' },
        ]}
      />
      <Routes>
        <Route index element={<Absence />} />
        <Route path="swaps" element={<Swaps />} />
        <Route path="extra-hours" element={<ExtraHours />} />
      </Routes>
    </>
  );
}

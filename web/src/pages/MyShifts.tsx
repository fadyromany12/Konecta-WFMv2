import { Route, Routes } from 'react-router-dom';
import { SubTabs } from '../App';
import { Absence } from './Absence';
import { MyWeek } from './MyWeek';
import { ExtraHours, Swaps } from './SelfService';

/**
 * Everything an advisor needs about their own time: the week they are working,
 * and then the three ways to change it — time off, swapping a shift with a
 * colleague, and bidding for extra hours.
 */
export function MyShifts() {
  return (
    <>
      <SubTabs
        items={[
          { to: '/my', label: 'My Week' },
          { to: '/my/time-off', label: 'Time Off' },
          { to: '/my/swaps', label: 'Shift Swaps' },
          { to: '/my/extra-hours', label: 'Extra Hours' },
        ]}
      />
      <Routes>
        {/* "When am I working" leads, because it is why the tab gets opened. */}
        <Route index element={<MyWeek />} />
        <Route path="time-off" element={<Absence />} />
        <Route path="swaps" element={<Swaps />} />
        <Route path="extra-hours" element={<ExtraHours />} />
      </Routes>
    </>
  );
}

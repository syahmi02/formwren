import { Children, type ReactElement } from 'react';
import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import type { HostProps } from '../contract.ts';
import { useComponentModel, useModelsProps, useSignal } from '../host/index.tsx';
import { useWrittenState } from './bound.ts';

interface TabsProps {
  selectedIndex?: number;
}

/** Each child is a page. Pages stay mounted and are hidden with the `hidden` attribute. */
export function TabsView({ props, write, fire, children }: HostProps<TabsProps>): ReactElement {
  const model = useComponentModel();
  const pages = useSignal(model.children);
  const titles = useModelsProps(pages, (p, m) => (typeof p.title === 'string' && p.title !== '' ? p.title : m.id));
  const requested = typeof props.selectedIndex === 'number' && Number.isInteger(props.selectedIndex) ? props.selectedIndex : 0;
  const [index, setIndex] = useWrittenState('selectedIndex', requested, write);
  const selected = Math.min(Math.max(index, 0), Math.max(pages.length - 1, 0));
  // The host renders the pages in order, so they pair with the models by position.
  const nodes = Children.toArray(children);

  return (
    <Tabs
      className="fw-tabs"
      selectedKey={pages[selected]?.id ?? null}
      isDisabled={props.disabled === true}
      onSelectionChange={(key) => {
        const next = pages.findIndex((page) => page.id === key);
        if (next < 0 || next === selected) return;
        setIndex(next, () => fire('change', { selectedIndex: next }));
      }}
    >
      <TabList className="fw-tabs__list" aria-label="Pages">
        {pages.map((page, i) => (
          <Tab key={page.id} id={page.id} className="fw-tabs__tab">
            {titles[i]}
          </Tab>
        ))}
      </TabList>
      {pages.map((page, i) => (
        <TabPanel
          key={page.id}
          id={page.id}
          className="fw-tabs__panel"
          shouldForceMount
          hidden={i !== selected}
          style={{ position: 'relative' }}
        >
          {nodes[i]}
        </TabPanel>
      ))}
    </Tabs>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { TitleCard } from './TitleCard';
import type { Title } from '../lib/types';

interface TitleRowProps {
  heading: string;
  titles: Title[];
  moreHref?: string;
  emptyHint?: string;
}

export function TitleRow({ heading, titles, moreHref, emptyHint }: TitleRowProps) {
  const scroller = useRef<HTMLDivElement>(null);

  /**
   * How far along the shelf is, as a fraction. A row that runs off the edge
   * gives no clue how much is left, and a scrollbar is hidden, so this is the
   * only thing telling a viewer there is more.
   */
  const [scrolled, setScrolled] = useState(0);
  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const travel = element.scrollWidth - element.clientWidth;
    setScrolled(travel > 4 ? element.scrollLeft / travel : 0);
  }, []);

  useEffect(() => {
    measure();
    const element = scroller.current;
    if (!element) return;
    // Resizing changes how much overflows, so the indicator is remeasured too.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, titles.length]);

  /**
   * Pages by just under a full width, so one tile stays on screen as an anchor
   * and the viewer does not lose their place between presses.
   */
  const page = (direction: 1 | -1) => {
    const element = scroller.current;
    if (!element) return;
    element.scrollBy({ left: direction * element.clientWidth * 0.85, behavior: 'smooth' });
  };

  if (titles.length === 0 && !emptyHint) return null;

  return (
    <section className="row">
      <header className="row__header">
        <h2 className="row__heading">{heading}</h2>
        {moreHref && titles.length > 0 && (
          <Link className="row__more" to={moreHref}>
            See all
          </Link>
        )}
      </header>
      {titles.length === 0 ? (
        <p className="row__empty">{emptyHint}</p>
      ) : (
        <>
          <button
            type="button"
            className="row__arrow row__arrow--start"
            aria-label={`Scroll ${heading} left`}
            onClick={() => page(-1)}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <div className="row__scroller" ref={scroller} onScroll={measure}>
            {titles.map((title) => (
              <TitleCard key={title.id} title={title} />
            ))}
          </div>
          <button
            type="button"
            className="row__arrow row__arrow--end"
            aria-label={`Scroll ${heading} right`}
            onClick={() => page(1)}
          >
            <span aria-hidden="true">›</span>
          </button>
          <span className="row__track" aria-hidden="true">
            <span className="row__track-thumb" style={{ left: `${scrolled * 60}%` }} />
          </span>
        </>
      )}
    </section>
  );
}

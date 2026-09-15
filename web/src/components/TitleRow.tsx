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
        <div className="row__scroller">
          {titles.map((title) => (
            <TitleCard key={title.id} title={title} />
          ))}
        </div>
      )}
    </section>
  );
}

import { Link, useParams } from 'react-router-dom';
import { Spinner } from '../components/Spinner';
import { TitleCard } from '../components/TitleCard';
import { TitleRow } from '../components/TitleRow';
import { CourseView } from '../components/CourseView';
import { useCatalog } from '../lib/CatalogProvider';
import { isCourse } from '../lib/course';

/**
 * One shelf, at any depth. A collection with children shows them as rows, and
 * whatever is filed directly here as a grid underneath, so the same page serves
 * "Trading", "Elliott Wave" and a named course without three layouts.
 */
export function CollectionPage() {
  const { collectionId = '' } = useParams();
  const { loading, collectionById, childrenOf, titlesDirectlyIn, titlesBeneath, pathTo } = useCatalog();

  if (loading) {
    return (
      <div className="page page--centered">
        <Spinner label="Loading catalog" />
      </div>
    );
  }

  const collection = collectionById(collectionId);
  if (!collection) {
    return (
      <div className="page page--centered">
        <p>That collection does not exist.</p>
        <Link className="button button--primary" to="/">
          Back to browse
        </Link>
      </div>
    );
  }

  const children = childrenOf(collection.id);
  const ownTitles = titlesDirectlyIn(collection.id);
  const trail = pathTo(collection.id).slice(0, -1);

  // A collection holding videos rather than more collections is a course, and
  // a course is an ordered thing with a position in it. A grid of tiles cannot
  // say which lesson is next, so it gets a syllabus instead.
  if (isCourse(children, ownTitles)) {
    return <CourseView collection={collection} titles={ownTitles} trail={trail} />;
  }

  return (
    <main className="page">
      <header className="page__header">
        {trail.length > 0 && (
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <Link to="/">Home</Link>
            {trail.map((ancestor) => (
              <Link key={ancestor.id} to={`/c/${ancestor.id}`}>
                {ancestor.name}
              </Link>
            ))}
          </nav>
        )}
        <h1>{collection.name}</h1>
        {collection.description && <p className="page__subtitle">{collection.description}</p>}
      </header>

      {children.map((child) => (
        <TitleRow
          key={child.id}
          heading={child.name}
          titles={titlesBeneath(child.id)}
          moreHref={`/c/${child.id}`}
        />
      ))}

      {ownTitles.length > 0 && (
        <div className="grid">
          {ownTitles.map((title) => (
            <TitleCard key={title.id} title={title} />
          ))}
        </div>
      )}

      {children.length === 0 && ownTitles.length === 0 && (
        <p className="row__empty">Nothing here yet.</p>
      )}
    </main>
  );
}

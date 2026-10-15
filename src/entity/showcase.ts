// Hand-curated entity-view showcase data, keyed by node id. Moved from
// public/field/js-interface/entity-data/showcase-vera-molnar.js when the
// entity view became server-rendered (src/entity/view.ts).
//
// Vera Molnár — source_origin: ai_assisted (transcribed from Iri's
// 2026-05-03 mock + publicly documented biographical fact); confidence:
// medium; review_pending. AI-assisted profiles are flagged so the editorial
// layer is visibly draft until human review or practitioner contribution
// upgrades the source_origin. The page surfaces the badge in its footer.

export interface ShowcaseWork {
  slug?: string;
  title: string;
  year?: string;
  medium?: string;
  method?: string;
  blurb?: string;
  img_descriptor?: string;
  graph_id?: string | null;
}

export interface Showcase {
  id: string;
  type: string;
  slug: string;
  name_display?: string;
  dates_compact?: string;
  tagline_disciplines?: string[];
  tagline_cf?: string[];
  hero?: { artwork_id?: string; drop?: string; fallback_copy?: string };
  born?: { date: string; place: string };
  died?: { date: string; place: string };
  nationality?: string;
  pronunciation?: string;
  disciplines_full?: string[];
  movements?: string[];
  bio?: string;
  quote?: { text: string; attribution: string };
  works?: ShowcaseWork[];
  relation_qualifiers?: Record<string, string>;
  collections?: string[];
  exhibitions_selected?: Array<{ year: string; title: string; venue?: string }>;
  awards?: Array<{ year: string; title: string; body?: string }>;
  source_origin?: string;
  confidence?: string;
  last_updated?: string;
  review_pending?: boolean;
}

export const SHOWCASE: Record<string, Showcase> = {
  "practitioner:vera molnar": {
    "id": "practitioner:vera molnar",
    "type": "practitioner",
    "slug": "molnar-vera",
    "name_display": "Molnár, Vera",
    "dates_compact": "1924—2023",
    "tagline_disciplines": [
      "generative",
      "algorithmic",
      "geometric-abstraction"
    ],
    "tagline_cf": [
      "art-concret",
      "early-computer-art"
    ],
    "hero": {
      "artwork_id": "artwork:molndrian",
      "drop": "plotter drawing, late 1970s. algorithmic riff on Mondrian-style geometry.",
      "fallback_copy": "img.hero / signature work — awaiting linkage"
    },
    "born": {
      "date": "1924-01-05",
      "place": "Budapest, HU"
    },
    "died": {
      "date": "2023-12-07",
      "place": "Paris, FR"
    },
    "nationality": "HU / FR",
    "pronunciation": "/'vɛrɐ 'mɔlnaːr/",
    "disciplines_full": [
      "generative",
      "algorithmic",
      "geometric-abstraction",
      "plotter"
    ],
    "movements": [
      "art-concret",
      "constructivism",
      "early-computer-art"
    ],
    "bio": "Hungarian-French artist, pioneer of computer-generated and algorithmic art. Worked with rule-based geometry from 1959; programmed plotter drawings from 1968.",
    "quote": {
      "text": "Without the aid of a computer, it would not be possible to materialize quite so faithfully an image that previously existed only in the artist's mind. This may sound paradoxical, but the machine, which is thought to be cold and inhuman, can help to realize what is most subjective, unattainable, and profound in a human being.",
      "attribution": "Vera Molnár, on the machine imaginaire"
    },
    "works": [
      {
        "slug": "sainte-victoire-serie",
        "title": "Sainte-Victoire, série",
        "year": "1959",
        "medium": "gouache on paper",
        "method": "manual, rule-based",
        "blurb": "Pre-computer. Hand-executed algorithms. The system precedes the machine.",
        "img_descriptor": "early gouache study, mountain silhouette in stepped greys",
        "graph_id": null
      },
      {
        "slug": "interruptions",
        "title": "Interruptions",
        "year": "1968—1969",
        "medium": "plotter drawing, ink on paper",
        "method": "Fortran · Benson plotter",
        "blurb": "First plotter series. Order disturbed by programmed deletion.",
        "img_descriptor": "field of short black line segments at varying angles, with rectangular voids cut out",
        "graph_id": "artwork:interruptions"
      },
      {
        "slug": "un-pourcent-de-desordre",
        "title": "(Un Pourcent de) Désordre",
        "year": "1974",
        "medium": "plotter drawing",
        "method": "Fortran",
        "blurb": "Disorder as a measurable parameter.",
        "img_descriptor": "concentric rectangles, each progressively perturbed by 1% increments of disorder",
        "graph_id": "artwork:desordres"
      },
      {
        "slug": "lent-mouvement-giratoire",
        "title": "Lent Mouvement Giratoire",
        "year": "1976",
        "medium": "plotter drawing, ink on paper",
        "method": "Fortran",
        "blurb": "",
        "img_descriptor": "rotating square nested inside square, slow drift of orientation",
        "graph_id": null
      },
      {
        "slug": "hypertransformations",
        "title": "Hypertransformations",
        "year": "1985—1987",
        "medium": "plotter drawing, color ink",
        "method": "BASIC",
        "blurb": "",
        "img_descriptor": "nested squares with color rotations and frame distortions",
        "graph_id": null
      },
      {
        "slug": "lettres-de-ma-mere",
        "title": "Lettres de ma mère",
        "year": "1981—2019 (ongoing)",
        "medium": "ink on paper, screen print, software",
        "method": "Fortran · later HTML/JS",
        "blurb": "Forty-year-long project. Memory rendered as parameter.",
        "img_descriptor": "horizontal lines that mimic the cursive handwriting of the artist's mother, generated from variation rules",
        "graph_id": null
      }
    ],
    "relation_qualifiers": {
      "practitioner:francois molnar": "spouse · collaborator",
      "practitioner:manfred mohr": "contemporary",
      "practitioner:frieder nake": "contemporary",
      "practitioner:georg nees": "contemporary",
      "practitioner:harold cohen": "contemporary",
      "practitioner:waldemar cordeiro": "contemporary",
      "practitioner:charles csuri": "contemporary",
      "concept:algorithmic drawing": "primary subject",
      "concept:plotter art": "primary subject",
      "concept:computer graphics": "method",
      "concept:systematic geometry": "method",
      "concept:algorithmic art": "primary subject",
      "concept:generative": "primary subject",
      "concept:machine imaginaire": "self-coined method",
      "concept:combinatorics": "method",
      "concept:controlled disorder": "method",
      "institution:centre pompidou": "collection",
      "institution:moma": "collection",
      "institution:tate": "collection",
      "institution:beaux-arts budapest": "education · 1942–47",
      "institution:v&a": "collection",
      "institution:ludwig museum budapest": "collection",
      "institution:venice biennale": "lifetime · 2022",
      "platform:fortran": "tool · 1968–",
      "platform:benson plotter": "tool · 1968–",
      "platform:basic": "tool",
      "scene:early computer art": "context",
      "scene:generative art": "context",
      "scene:paris 1960s": "context",
      "collective:grav": "adjacent practice"
    },
    "collections": [
      "Centre Pompidou, Paris",
      "MoMA, New York",
      "Tate, London",
      "Victoria & Albert Museum, London",
      "Ludwig Museum, Budapest",
      "Vehbi Koç Foundation"
    ],
    "exhibitions_selected": [
      {
        "year": "1976",
        "title": "Transformations",
        "venue": "Polytechnic of Central London"
      },
      {
        "year": "2018",
        "title": "Une rétrospective 1942–2012",
        "venue": "Musée des Beaux-Arts, Rennes"
      },
      {
        "year": "2022",
        "title": "Plotting Calm",
        "venue": "Beall Center, UC Irvine"
      },
      {
        "year": "2023",
        "title": "Vera Molnár: Pioneer of Generative Art",
        "venue": "59th Venice Biennale (lifetime · Golden Lion)"
      },
      {
        "year": "2024",
        "title": "Vera Molnár, Variations",
        "venue": "Centre Pompidou, Paris"
      }
    ],
    "awards": [
      {
        "year": "2005",
        "title": "Médaille d'or",
        "body": "Académie d'Architecture, Paris"
      },
      {
        "year": "2007",
        "title": "AWARE / d'Ornano (later)",
        "body": ""
      },
      {
        "year": "2022",
        "title": "Golden Lion for Lifetime Achievement",
        "body": "59th Venice Biennale"
      }
    ],
    "source_origin": "ai_assisted",
    "confidence": "medium",
    "last_updated": "2026-05-03",
    "review_pending": true
  }
};

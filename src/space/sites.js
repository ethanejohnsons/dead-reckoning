// Where rockets leave from: the world's launch sites, as places the game can put a pad. Only places with real
// launch pads are listed.
//
// lat, lon: the pad itself. az: the compass direction launches from there usually take (the autopilot's
// default; due east gives the most help from the Earth's turning and an orbit inclined by the site's latitude).
// A rocket can also be stood up anywhere else: a pin on the map makes a site of its own (pinSite).

export const SITES = [
  { id: 'ksc39a', name: 'Kennedy Space Center, Pad 39A', place: 'Merritt Island, Florida', group: 'United States', lat: 28.60827, lon: -80.60414, az: 90,
    blurb: 'Every Apollo crew to the Moon but one left from this pad.' },
  { id: 'ksc39b', name: 'Kennedy Space Center, Pad 39B', place: 'Merritt Island, Florida', group: 'United States', lat: 28.62716, lon: -80.62084, az: 90,
    blurb: 'Apollo 10, Skylab\'s crews and Artemis: the northern of the two great pads.' },
  { id: 'slc40', name: 'Cape Canaveral, Launch Complex 40', place: 'Cape Canaveral, Florida', group: 'United States', lat: 28.56194, lon: -80.57735, az: 90,
    blurb: 'The busiest pad on the Cape, a mile from the Atlantic surf.' },
  { id: 'starbase', name: 'Starbase', place: 'Boca Chica, Texas', group: 'United States', lat: 25.99618, lon: -97.15448, az: 93,
    blurb: 'The last beach in Texas before the Rio Grande, and Starship\'s home.' },
  { id: 'vandenberg', name: 'Vandenberg, Launch Complex 4', place: 'Lompoc, California', group: 'United States', lat: 34.63209, lon: -120.61068, az: 182,
    blurb: 'The marine layer rolls in off the Pacific; launches go south over open ocean, toward the poles.' },
  { id: 'wallops', name: 'Wallops Island, Pad 0A', place: 'Wallops Island, Virginia', group: 'United States', lat: 37.83378, lon: -75.48774, az: 105,
    blurb: 'A barrier island on the Virginia shore, launching over the Atlantic since 1945.' },
  { id: 'kodiak', name: 'Pacific Spaceport Complex', place: 'Kodiak Island, Alaska', group: 'United States', lat: 57.43583, lon: -152.33778, az: 150,
    blurb: 'Narrow Cape, Kodiak: fog, rain and a clear run south over the Gulf of Alaska.' },
  { id: 'kourou', name: 'Guiana Space Centre', place: 'Kourou, French Guiana', group: 'The world', lat: 5.23900, lon: -52.76850, az: 90,
    blurb: 'Five degrees from the equator, where the Earth\'s turning gives the most for free.' },
  { id: 'baikonur', name: 'Baikonur Cosmodrome, Site 1', place: 'Kazakhstan', group: 'The world', lat: 45.92030, lon: 63.34220, az: 64,
    blurb: 'Gagarin\'s Start, on the Kazakh steppe: Sputnik and the first human left from here.' },
  { id: 'vostochny', name: 'Vostochny Cosmodrome', place: 'Amur Oblast, Russia', group: 'The world', lat: 51.88440, lon: 128.33400, az: 70,
    blurb: 'Taiga in every direction, and winter for half the year.' },
  { id: 'tanegashima', name: 'Tanegashima Space Center', place: 'Kagoshima, Japan', group: 'The world', lat: 30.40090, lon: 130.97510, az: 100,
    blurb: 'Often called the most beautiful launch site in the world: cliffs, surf and a rocket.' },
  { id: 'wenchang', name: 'Wenchang Space Launch Site', place: 'Hainan, China', group: 'The world', lat: 19.61450, lon: 110.95100, az: 100,
    blurb: 'Palm groves on the South China Sea, and typhoons in season.' },
  { id: 'jiuquan', name: 'Jiuquan Satellite Launch Center', place: 'Gobi Desert, China', group: 'The world', lat: 40.96060, lon: 100.29830, az: 135,
    blurb: 'Deep in the Gobi: dust storms and a sky that is usually cloudless.' },
  { id: 'sriharikota', name: 'Satish Dhawan Space Centre', place: 'Sriharikota, India', group: 'The world', lat: 13.71990, lon: 80.23040, az: 105,
    blurb: 'A spindle of an island on the Bay of Bengal, under the monsoon.' },
  { id: 'alcantara', name: 'Alcântara Launch Center', place: 'Maranhão, Brazil', group: 'The world', lat: -2.37300, lon: -44.39640, az: 90,
    blurb: 'Two degrees south of the equator on the Atlantic coast of Brazil.' },
  { id: 'naro', name: 'Naro Space Center', place: 'Goheung, South Korea', group: 'The world', lat: 34.43190, lon: 127.53510, az: 170,
    blurb: 'An island off the south coast of Korea, launching between Japan and China.' },
];
export const DEFAULT_SITE = 'ksc39a';
export const siteById = (id) => SITES.find((s) => s.id === id);
/** A site made of a pin on the map. */
export const pinSite = (lat, lon) => ({ id: 'pin', name: 'your own pad', place: '', lat, lon, az: 90, blurb: '' });

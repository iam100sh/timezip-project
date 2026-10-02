// Vercel 서버리스 함수: TMAP(SK open API) 중간 서버
// 인증키(TMAP_APP_KEY)는 Vercel 환경변수에만 두고, 브라우저에는 절대 보내지 않아요.
//
//   /api/tmap?type=walk&sx=127.06&sy=37.61&ex=127.07&ey=37.62
//       → 보행자 경로: 실제 도보 거리·시간 + 지도에 그릴 경로 선 (무료 하루 1,000건)
//   /api/tmap?type=transit&sx=..&sy=..&ex=..&ey=..
//       → 대중교통 경로 (환승 포함) (무료 하루 10건뿐이라 하루 동안 결과를 저장해 두고 다시 써요)
//
// x = 경도(lng), y = 위도(lat)

const BASE = 'https://apis.openapi.sk.com';

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const type = url.searchParams.get('type');
  const key = process.env.TMAP_APP_KEY;
  if (!key) return send(res, 500, { error: '서버에 TMAP_APP_KEY가 설정되지 않았어요.' });

  const p = ['sx', 'sy', 'ex', 'ey'].map((name) => Number(url.searchParams.get(name)));
  if (p.some((v) => !isFinite(v) || v === 0)) return send(res, 400, { error: 'sx, sy, ex, ey(출발·도착 좌표)가 필요해요.' });
  const [sx, sy, ex, ey] = p;

  try {
    if (type === 'walk') {
      const data = await callTmap('/tmap/routes/pedestrian?version=1', {
        startX: sx, startY: sy, endX: ex, endY: ey, startName: '출발', endName: '도착'
      }, key);
      const features = data.features || [];
      const first = features[0] ? features[0].properties : {};
      const path = []; // [[lng, lat], ...]
      features.forEach((f) => {
        if (f.geometry && f.geometry.type === 'LineString') f.geometry.coordinates.forEach((c) => path.push(c));
      });
      return send(res, 200, { distance: first.totalDistance, seconds: first.totalTime, path: path }, 86400);
    }

    if (type === 'transit') {
      const data = await callTmap('/transit/routes', {
        startX: String(sx), startY: String(sy), endX: String(ex), endY: String(ey), count: 5, lang: 0, format: 'json'
      }, key);
      if (data.result && data.result.status && !data.metaData) { // 경로가 없을 때 (예: 너무 가까움)
        return send(res, 200, { itineraries: [], message: data.result.message }, 86400);
      }
      const plans = (data.metaData && data.metaData.plan && data.metaData.plan.itineraries) || [];
      return send(res, 200, { itineraries: plans.map(simplifyItinerary) }, 86400); // 같은 구간은 하루 동안 다시 쓰기
    }

    return send(res, 400, { error: 'type은 walk 또는 transit이에요.' });
  } catch (err) {
    if (err.quota) return send(res, 429, { error: 'quota', message: '오늘 TMAP 사용 한도를 다 썼어요.' });
    return send(res, 502, { error: 'TMAP 정보를 가져오지 못했어요.', detail: String(err.message || err) });
  }
};

async function callTmap(path, body, key) {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { appKey: key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { /* 아래에서 처리 */ }
  if (response.status === 429 || /QUOTA|LIMIT/i.test(JSON.stringify(data.error || ''))) {
    const e = new Error('quota'); e.quota = true; throw e; // 무료 한도 초과 → 자동 차단
  }
  if (!response.ok) throw new Error('TMAP HTTP ' + response.status + ' ' + text.slice(0, 200));
  return data;
}

// TMAP 경로 하나 → 화면에 필요한 것만
function simplifyItinerary(it) {
  return {
    minutes: Math.round(it.totalTime / 60),
    walkMinutes: Math.round(it.totalWalkTime / 60),
    transfers: it.transferCount,
    fare: it.fare && it.fare.regular ? it.fare.regular.totalFare : null,
    legs: it.legs.map((l) => {
      const stations = (l.passStopList && l.passStopList.stations) || [];
      return {
        mode: l.mode,                       // WALK, BUS, SUBWAY, EXPRESSBUS, TRAIN ...
        route: l.route || '',               // 예: "마을:노원09", "수도권1호선"
        routeColor: l.routeColor || '',
        minutes: Math.max(1, Math.round(l.sectionTime / 60)),
        distance: l.distance,
        start: { name: l.start.name, lat: l.start.lat, lng: l.start.lon },
        end: { name: l.end.name, lat: l.end.lat, lng: l.end.lon },
        stops: stations.length ? stations.length - 1 : 0 // 몇 정거장
      };
    })
  };
}

function send(res, status, body, cacheSeconds) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cacheSeconds) res.setHeader('Cache-Control', 's-maxage=' + cacheSeconds + ', stale-while-revalidate');
  res.end(JSON.stringify(body));
}

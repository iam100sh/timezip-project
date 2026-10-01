// Vercel 서버리스 함수: 서울시 버스 API 중간 서버
// 인증키(BUS_API_KEY)는 Vercel 환경변수에만 두고, 브라우저에는 절대 보내지 않아요.
//
//   /api/bus?type=nearby&lat=37.61&lng=127.06   → 주변 정류장 목록
//   /api/bus?type=arrivals&arsId=11283          → 정류장을 지나는 버스와 도착 정보

const BASE = 'http://ws.bus.go.kr/api/rest/stationinfo';

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const type = url.searchParams.get('type');
  const key = process.env.BUS_API_KEY;

  if (!key) return send(res, 500, { error: '서버에 BUS_API_KEY가 설정되지 않았어요.' });

  try {
    if (type === 'nearby') {
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lng'));
      const radius = Math.min(Math.max(Number(url.searchParams.get('radius')) || 500, 50), 1000);
      if (!isFinite(lat) || !isFinite(lng)) return send(res, 400, { error: 'lat, lng가 필요해요.' });

      const items = await callBusApi('getStationByPos', { tmX: lng, tmY: lat, radius: radius }, key);
      const stations = items.map((s) => ({
        arsId: s.arsId,
        name: s.stationNm,
        lat: Number(s.gpsY),
        lng: Number(s.gpsX),
        dist: Number(s.dist)
      })).filter((s) => s.arsId && s.arsId !== '0'); // 정류장 번호가 없는 곳(가상 정류장)은 빼요
      return send(res, 200, { stations: stations }, 3600); // 정류장 위치는 잘 안 바뀌니 1시간 캐시

    }

    if (type === 'arrivals') {
      const arsId = url.searchParams.get('arsId') || '';
      if (!/^\d{5}$/.test(arsId)) return send(res, 400, { error: 'arsId(정류장 번호 5자리)가 필요해요.' });

      const items = await callBusApi('getStationByUid', { arsId: arsId }, key);
      const buses = items.map((b) => ({
        route: b.rtNm,
        routeType: b.routeType,  // 1 공항, 2 마을, 3 간선, 4 지선, 5 순환, 6 광역, 7 인천, 8 경기
        direction: b.adirection, // 종점 방향
        nextStation: b.nxtStn,   // 다음 정류장
        arrival1: b.arrmsg1,     // 첫 번째 버스 (예: "3분12초후[2번째 전]")
        arrival2: b.arrmsg2,     // 두 번째 버스
        last1: b.isLast1 === '1',        // 막차인지
        lowFloor1: b.busType1 === '1',   // 저상버스인지
        congestion1: b.congestion1,      // 혼잡도: 3 여유, 4 보통, 5 혼잡 (0이면 정보 없음)
        firstTime: formatTime(b.firstTm), // 첫차 시각 (예: "04:00")
        lastTime: formatTime(b.lastTm)    // 막차 시각
      }));
      return send(res, 200, { arsId: arsId, name: items[0] ? items[0].stNm : '', buses: buses }, 20); // 도착 정보는 20초 캐시
    }

    return send(res, 400, { error: 'type은 nearby 또는 arrivals예요.' });
  } catch (err) {
    return send(res, 502, { error: '버스 정보를 가져오지 못했어요.', detail: String(err.message || err) });
  }
};

async function callBusApi(operation, params, key) {
  const query = new URLSearchParams(Object.assign({ serviceKey: key, resultType: 'json' }, params));
  const response = await fetch(BASE + '/' + operation + '?' + query.toString());
  if (!response.ok) throw new Error('HTTP ' + response.status);

  const data = await response.json();
  const header = data.msgHeader || {};
  if (header.headerCd !== '0' && header.headerCd !== '4') { // 4는 "결과 없음"
    throw new Error(header.headerMsg || '알 수 없는 오류');
  }
  return (data.msgBody && data.msgBody.itemList) || [];
}

// "0400  " → "04:00"
function formatTime(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(0, 2) + ':' + digits.slice(2, 4) : '';
}

function send(res, status, body, cacheSeconds) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cacheSeconds) res.setHeader('Cache-Control', 's-maxage=' + cacheSeconds + ', stale-while-revalidate');
  res.end(JSON.stringify(body));
}

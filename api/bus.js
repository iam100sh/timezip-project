// Vercel 서버리스 함수: 서울시 + 경기도 버스 API 중간 서버
// 인증키(BUS_API_KEY)는 Vercel 환경변수에만 두고, 브라우저에는 절대 보내지 않아요.
//
//   /api/bus?type=nearby&lat=37.61&lng=127.06&radius=500
//       → 주변 정류장 목록 (서울 + 경기, 같은 정류장은 하나로 합쳐요)
//   /api/bus?type=arrivals&id=110000183&arsId=11283&seoul=1&gg=1
//       → 정류장을 지나는 버스와 도착 정보 (서울 버스 + 경기 버스)
//
// 도착 정보는 서울/경기 모두 같은 모양으로 바꿔서 보내요:
//   { status: 'running' | 'soon' | 'garage' | 'wait' | 'ended' | 'none', minutes, stops }

const SEOUL = 'http://ws.bus.go.kr/api/rest/stationinfo';
const GG = 'https://apis.data.go.kr/6410000';

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

      // 서울과 경기를 동시에 물어보고, 한쪽이 실패해도 다른 쪽 결과는 보여줘요
      const [seoul, gg] = await Promise.allSettled([
        callSeoul('getStationByPos', { tmX: lng, tmY: lat, radius: radius }, key),
        callGG('busstationservice/v2/getBusStationAroundListv2', { x: lng, y: lat }, key, 'busStationAroundList')
      ]);
      if (seoul.status === 'rejected' && gg.status === 'rejected') throw seoul.reason;

      // 정류장 ID → 정류장. 서울 API와 경기 API가 같은 정류장에 같은 ID를 써서 합칠 수 있어요.
      // 서울 정류장 ID는 1로, 경기 정류장 ID는 2로 시작해요.
      // 주의: 정류장 "번호"(arsId)는 서울과 경기가 겹쳐요. (경기 03165 = 서울 용산구의 다른 정류장)
      //       그래서 서울 API에는 서울 정류장만 물어보고, 경기 정류장은 경기 API로만 물어봐요.
      const stops = new Map();
      (seoul.value || []).forEach((s) => {
        const id = String(s.stationId);
        const inSeoul = id.charAt(0) === '1';
        if (inSeoul && (!s.arsId || s.arsId === '0')) return; // 정류장 번호가 없는 가상 정류장은 빼요
        if (/미정차/.test(s.stationNm)) return; // 버스가 서지 않는 곳
        stops.set(id, {
          id: id, arsId: inSeoul ? s.arsId : '', name: s.stationNm,
          lat: Number(s.gpsY), lng: Number(s.gpsX), dist: Number(s.dist),
          seoul: inSeoul, gg: !inSeoul, region: inSeoul ? '서울' : '경기'
        });
      });
      (gg.value || []).forEach((s) => {
        const id = String(s.stationId);
        const mobileNo = String(s.mobileNo || '').trim();
        if (Number(s.distance) > radius) return;
        const known = stops.get(id);
        if (known) { // 서울 API에도 있는 정류장
          known.gg = true; // 서울 정류장이면 그곳에 서는 경기 버스도 가져오게
          if (!known.seoul) { known.arsId = /^0+$/.test(mobileNo) ? '' : mobileNo; known.region = s.regionName || '경기'; }
          return;
        }
        if (/^0*$/.test(mobileNo) || /미정차/.test(s.stationName)) return; // 번호 없는 곳, 서지 않는 곳은 빼요
        stops.set(id, {
          id: id, arsId: mobileNo, name: s.stationName,
          lat: Number(s.y), lng: Number(s.x), dist: Number(s.distance),
          seoul: false, gg: true, region: s.regionName || '경기'
        });
      });

      const list = Array.from(stops.values()).sort((a, b) => a.dist - b.dist);
      return send(res, 200, { stations: list }, 3600); // 정류장 위치는 잘 안 바뀌니 1시간 캐시
    }

    if (type === 'arrivals') {
      const id = url.searchParams.get('id') || '';
      const arsId = url.searchParams.get('arsId') || '';
      const wantSeoul = url.searchParams.get('seoul') === '1' && id.charAt(0) === '1'; // 서울 API에는 서울 정류장만 (번호가 경기와 겹쳐서)
      const wantGG = url.searchParams.get('gg') === '1';
      if (wantSeoul && !/^\d{5}$/.test(arsId)) return send(res, 400, { error: 'arsId(정류장 번호 5자리)가 필요해요.' });
      if (wantGG && !/^\d{6,12}$/.test(id)) return send(res, 400, { error: 'id(정류장 ID)가 필요해요.' });

      const [seoul, gg] = await Promise.allSettled([
        wantSeoul ? callSeoul('getStationByUid', { arsId: arsId }, key) : Promise.resolve([]),
        wantGG ? callGG('busarrivalservice/v2/getBusArrivalListv2', { stationId: id }, key, 'busArrivalList') : Promise.resolve([])
      ]);
      if (seoul.status === 'rejected' && gg.status === 'rejected') throw seoul.reason;

      const seoulBuses = (seoul.value || []).map(fromSeoul);
      const ggBuses = (gg.value || []).map(fromGG);
      return send(res, 200, { buses: mergeBuses(seoulBuses, ggBuses) }, 20); // 도착 정보는 20초 캐시
    }

    return send(res, 400, { error: 'type은 nearby 또는 arrivals예요.' });
  } catch (err) {
    return send(res, 502, { error: '버스 정보를 가져오지 못했어요.', detail: String(err.message || err) });
  }
};

// ───── 서울 ─────

async function callSeoul(operation, params, key) {
  const query = new URLSearchParams(Object.assign({ serviceKey: key, resultType: 'json' }, params));
  const response = await fetch(SEOUL + '/' + operation + '?' + query.toString());
  if (!response.ok) throw new Error('서울 HTTP ' + response.status);
  const data = await response.json();
  const header = data.msgHeader || {};
  if (header.headerCd !== '0' && header.headerCd !== '4') throw new Error(header.headerMsg || '서울 API 오류'); // 4는 "결과 없음"
  return (data.msgBody && data.msgBody.itemList) || [];
}

// 서울 노선 종류: 1 공항, 2 마을, 3 간선, 4 지선, 5 순환, 6 광역, 7 인천, 8 경기
function fromSeoul(b) {
  const last1 = b.isLast1 === '1' || /\[막차\]/.test(b.arrmsg1 || '');
  return {
    route: b.rtNm,
    type: 'S' + b.routeType,
    direction: b.adirection,
    nextStation: (b.nxtStn || '').trim(),
    arr1: parseSeoulMessage(b.arrmsg1),
    arr2: parseSeoulMessage(b.arrmsg2),
    last1: last1,
    lowFloor1: b.busType1 === '1',
    crowded1: b.congestion1 === '5' || b.congestion1 === '6',
    seats1: null,
    firstTime: formatTime(b.firstTm),
    lastTime: formatTime(b.lastTm)
  };
}

// "3분12초후[2번째 전]" → { status: 'running', minutes: 3, stops: 2 }
function parseSeoulMessage(message) {
  const text = String(message || '').replace('[막차]', '').trim();
  const m = text.match(/^(?:(\d+)분)?\s*(?:(\d+)초)?후\[(\d+)번째 전\]/);
  if (m && (m[1] || m[2])) {
    return { status: 'running', minutes: Number(m[1] || 0), seconds: Number(m[2] || 0), stops: Number(m[3]) };
  }
  if (text.indexOf('곧 도착') !== -1) return { status: 'soon' };
  if (text.indexOf('차고지') !== -1) return { status: 'garage' };
  if (text.indexOf('출발대기') !== -1 || text.indexOf('회차') !== -1) return { status: 'wait' };
  if (text.indexOf('운행종료') !== -1) return { status: 'ended' };
  return { status: 'none', text: text };
}

// ───── 경기 ─────

async function callGG(operation, params, key, listName) {
  const query = new URLSearchParams(Object.assign({ serviceKey: key, format: 'json' }, params));
  const response = await fetch(GG + '/' + operation + '?' + query.toString());
  if (!response.ok) throw new Error('경기 HTTP ' + response.status);
  const data = await response.json();
  if (data.OpenAPI_ServiceResponse) { // 인증키 오류 등은 이 모양으로 와요
    throw new Error(data.OpenAPI_ServiceResponse.cmmMsgHeader.returnAuthMsg || '경기 API 오류');
  }
  const body = data.response || {};
  const header = body.msgHeader || {};
  if (header.resultCode !== 0 && header.resultCode !== 4) throw new Error(header.resultMessage || '경기 API 오류'); // 4는 "결과 없음"
  const list = body.msgBody && body.msgBody[listName];
  if (!list) return [];
  return Array.isArray(list) ? list : [list]; // 결과가 하나면 배열이 아니라 객체로 와요
}

// 경기 노선 종류 코드(routeTypeCd): 11 직행좌석, 12 좌석, 13 일반, 14 광역급행, 30 마을 ...
function fromGG(b) {
  return {
    route: String(b.routeName),
    type: 'G' + b.routeTypeCd,
    direction: b.routeDestName,
    nextStation: '',
    arr1: parseGGArrival(b.predictTime1, b.locationNo1, b.flag),
    arr2: parseGGArrival(b.predictTime2, b.locationNo2, b.flag),
    last1: false,
    lowFloor1: String(b.lowPlate1) === '1',
    crowded1: String(b.crowded1) === '3' || String(b.crowded1) === '4', // 1 여유, 2 보통, 3 혼잡, 4 매우혼잡
    seats1: seatCount(b.remainSeatCnt1),
    firstTime: '',
    lastTime: ''
  };
}

function parseGGArrival(minutes, stops, flag) {
  if (minutes !== '' && minutes !== null && minutes !== undefined && !isNaN(Number(minutes))) {
    const m = Number(minutes);
    const s = Number(stops);
    if (m <= 1 && s <= 1) return { status: 'soon' };
    return { status: 'running', minutes: m, seconds: 0, stops: isNaN(s) ? null : s };
  }
  if (flag === 'STOP') return { status: 'ended' };
  if (flag === 'WAIT') return { status: 'wait' };
  return { status: 'none' }; // 지금 오고 있는 버스가 없어요
}

function seatCount(value) {
  const n = Number(value);
  return value === '' || value === null || isNaN(n) || n < 0 ? null : n; // -1이면 정보 없음
}

// 서울 API에도 경기 버스가 일부 섞여 와요("115남양주"). 경기 API에도 같은 버스("115")가 있으면 경기 쪽 정보를 써요.
function mergeBuses(seoulBuses, ggBuses) {
  const isSeoulOwn = (bus) => ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].indexOf(bus.type) !== -1;
  const result = seoulBuses.slice();
  ggBuses.forEach((gg) => {
    const i = result.findIndex((s) => !isSeoulOwn(s) && (s.route === gg.route || s.route.replace(/[가-힣]+$/, '') === gg.route));
    if (i === -1) { result.push(gg); return; }
    const seoul = result[i];
    if (gg.arr1.status === 'none' && seoul.arr1.status !== 'none') { // 경기 쪽에 도착 정보가 없으면 서울 쪽 도착 정보를 빌려요
      gg.arr1 = seoul.arr1;
      gg.arr2 = seoul.arr2;
    }
    gg.nextStation = seoul.nextStation;
    gg.firstTime = seoul.firstTime;
    gg.lastTime = seoul.lastTime;
    result[i] = gg;
  });
  return result;
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

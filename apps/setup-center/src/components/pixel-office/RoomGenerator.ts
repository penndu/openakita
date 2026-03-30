import type { SceneTheme } from './SceneTheme';
import { TILE, TILE_SIZE } from './TilesetManager';
import type { AreaType } from './StatusMapping';

export interface RoomDef {
  id: string;
  type: AreaType;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  seats: Array<{ x: number; y: number; id: string }>;
  department?: string;
}

export interface LayoutResult {
  mapWidth: number;
  mapHeight: number;
  tileData: number[][];
  rooms: RoomDef[];
}

interface DepartmentInfo {
  name: string;
  nodeIds: string[];
}

const ROOM_PADDING = 1;
const MIN_ROOM_W = 10;
const MIN_ROOM_H = 8;
const HALL_HEIGHT = 2;
const DEPT_COLS = 3;

function createEmptyMap(w: number, h: number): number[][] {
  return Array.from({ length: h }, () => new Array(w).fill(TILE.EMPTY));
}

function fillRect(map: number[][], x: number, y: number, w: number, h: number, tile: number) {
  for (let row = y; row < y + h && row < map.length; row++) {
    for (let col = x; col < x + w && col < map[0].length; col++) {
      map[row][col] = tile;
    }
  }
}

function drawRoom(map: number[][], rx: number, ry: number, rw: number, rh: number) {
  for (let row = ry + 1; row < ry + rh; row++) {
    for (let col = rx + 1; col < rx + rw - 1; col++) {
      map[row][col] = ((row + col) % 2 === 0) ? TILE.FLOOR : TILE.FLOOR_ALT;
    }
  }
  fillRect(map, rx, ry, rw, 1, TILE.WALL_TOP);
  for (let row = ry + 1; row < ry + rh; row++) {
    map[row][rx] = TILE.WALL_SIDE;
    map[row][rx + rw - 1] = TILE.WALL_SIDE;
  }
  map[ry][rx] = TILE.WALL_CORNER;
  map[ry][rx + rw - 1] = TILE.WALL_CORNER;
}

function placeDoor(map: number[][], rx: number, ry: number, rw: number, rh: number) {
  const doorX = rx + Math.floor(rw / 2);
  const doorY = ry + rh - 1;
  if (doorY < map.length && doorX < map[0].length) {
    map[doorY][doorX] = TILE.DOOR;
  }
}

export function generateLayout(
  departments: DepartmentInfo[],
  theme: SceneTheme,
): LayoutResult {
  const rooms: RoomDef[] = [];
  const deptCount = Math.max(departments.length, 1);

  const maxNodesInDept = Math.max(...departments.map(d => d.nodeIds.length), 2);
  const deptRoomW = Math.max(MIN_ROOM_W, Math.ceil(maxNodesInDept * 2.5) + 4);
  const deptRoomH = Math.max(MIN_ROOM_H, Math.ceil(maxNodesInDept / 2) + 5);

  const cols = Math.min(DEPT_COLS, deptCount);
  const deptRows = Math.ceil(deptCount / cols);

  const specialW = Math.max(MIN_ROOM_W, 10);
  const specialH = 7;

  const meetingW = Math.max(MIN_ROOM_W + 2, cols * (deptRoomW / 2) + 4);
  const meetingH = 8;

  const deptRowW = cols * (deptRoomW + ROOM_PADDING) + ROOM_PADDING;
  const totalW = Math.max(deptRowW, meetingW + specialW * 2 + ROOM_PADDING * 4, specialW * 2 + ROOM_PADDING * 4) + 4;

  // Vertical sections
  const entranceY = ROOM_PADDING;
  let cursorY = entranceY + specialH + HALL_HEIGHT + ROOM_PADDING;

  // Pre-calculate total height
  const deptSectionH = deptRows * (deptRoomH + HALL_HEIGHT + ROOM_PADDING);
  const meetingY = cursorY + deptSectionH;
  const totalH = meetingY + meetingH + ROOM_PADDING + 2;

  const map = createEmptyMap(totalW, totalH);

  // Hallway below entrance row
  fillRect(map, 0, entranceY + specialH, totalW, HALL_HEIGHT, TILE.FLOOR);

  // Entrance room (top-left)
  const entranceX = ROOM_PADDING + 1;
  drawRoom(map, entranceX, entranceY, specialW, specialH);
  placeDoor(map, entranceX, entranceY, specialW, specialH);
  rooms.push({
    id: 'entrance',
    type: 'entrance',
    label: theme.roomLabels.entrance,
    x: entranceX, y: entranceY, w: specialW, h: specialH,
    seats: [
      { x: (entranceX + 2) * TILE_SIZE, y: (entranceY + 3) * TILE_SIZE, id: 'entrance_0' },
      { x: (entranceX + 4) * TILE_SIZE, y: (entranceY + 3) * TILE_SIZE, id: 'entrance_1' },
    ],
  });

  // Break room (top-right)
  const breakX = totalW - specialW - ROOM_PADDING - 1;
  drawRoom(map, breakX, entranceY, specialW, specialH);
  placeDoor(map, breakX, entranceY, specialW, specialH);
  map[entranceY + 2][breakX + 2] = TILE.SOFA;
  map[entranceY + 2][breakX + specialW - 3] = TILE.COFFEE;
  rooms.push({
    id: 'break',
    type: 'break',
    label: theme.roomLabels.breakRoom,
    x: breakX, y: entranceY, w: specialW, h: specialH,
    seats: Array.from({ length: 4 }, (_, i) => ({
      x: (breakX + 2 + i) * TILE_SIZE,
      y: (entranceY + 4) * TILE_SIZE,
      id: `break_${i}`,
    })),
  });

  // Department rooms — grid layout
  departments.forEach((dept, idx) => {
    const gridCol = idx % cols;
    const gridRow = Math.floor(idx / cols);
    const rx = ROOM_PADDING + 1 + gridCol * (deptRoomW + ROOM_PADDING);
    const ry = cursorY + gridRow * (deptRoomH + HALL_HEIGHT + ROOM_PADDING);

    drawRoom(map, rx, ry, deptRoomW, deptRoomH);
    placeDoor(map, rx, ry, deptRoomW, deptRoomH);

    // Hallway below each dept row
    fillRect(map, 0, ry + deptRoomH, totalW, HALL_HEIGHT, TILE.FLOOR);

    const seats: RoomDef['seats'] = [];
    const seatCols = Math.floor((deptRoomW - 3) / 2);
    dept.nodeIds.forEach((nid, si) => {
      const seatCol = rx + 2 + (si % seatCols) * 2;
      const seatRow = ry + 2 + Math.floor(si / seatCols) * 2;

      if (seatRow < ry + deptRoomH - 1 && seatCol < rx + deptRoomW - 1) {
        map[seatRow][seatCol] = TILE.DESK;
        if (seatRow + 1 < ry + deptRoomH - 1) {
          map[seatRow + 1][seatCol] = TILE.CHAIR;
        }
        seats.push({ x: seatCol * TILE_SIZE, y: (seatRow + 1) * TILE_SIZE, id: nid });
      }
    });

    if (ry + 1 < map.length && rx + deptRoomW - 3 < map[0].length) {
      map[ry + 1][rx + deptRoomW - 3] = TILE.WHITEBOARD;
    }
    if (ry + 1 < map.length && rx + 1 < map[0].length) {
      map[ry + 1][rx + 1] = TILE.PLANT;
    }

    rooms.push({
      id: `dept_${dept.name}`,
      type: 'department',
      label: `${theme.roomLabels.department} · ${dept.name}`,
      x: rx, y: ry, w: deptRoomW, h: deptRoomH,
      seats,
      department: dept.name,
    });
  });

  // Meeting room (bottom center)
  const meetingX = Math.floor((totalW - meetingW) / 2);
  drawRoom(map, meetingX, meetingY, meetingW, meetingH);
  placeDoor(map, meetingX, meetingY, meetingW, meetingH);
  fillRect(map, 0, meetingY - HALL_HEIGHT, totalW, HALL_HEIGHT, TILE.FLOOR);

  const tableStartX = meetingX + Math.floor((meetingW - 4) / 2);
  for (let i = 0; i < 4; i++) {
    map[meetingY + 3][tableStartX + i] = TILE.MEETING_TABLE;
  }
  map[meetingY + 1][meetingX + meetingW - 3] = TILE.PROJECTOR;

  const meetingSeats: RoomDef['seats'] = [];
  const seatCount = Math.min(deptCount * 3, meetingW - 4);
  for (let i = 0; i < seatCount; i++) {
    const sx = meetingX + 2 + i;
    const sy = (i % 2 === 0) ? meetingY + 2 : meetingY + 5;
    meetingSeats.push({ x: sx * TILE_SIZE, y: sy * TILE_SIZE, id: `meeting_${i}` });
  }
  rooms.push({
    id: 'meeting',
    type: 'meeting',
    label: theme.roomLabels.meetingRoom,
    x: meetingX, y: meetingY, w: meetingW, h: meetingH,
    seats: meetingSeats,
  });

  // Debug room (bottom-right)
  const debugX = totalW - specialW - ROOM_PADDING - 1;
  drawRoom(map, debugX, meetingY, specialW, specialH);
  placeDoor(map, debugX, meetingY, specialW, specialH);
  map[meetingY + 2][debugX + 2] = TILE.SERVER;
  map[meetingY + 2][debugX + 4] = TILE.SERVER;
  rooms.push({
    id: 'debug',
    type: 'debug',
    label: theme.roomLabels.debugArea,
    x: debugX, y: meetingY, w: specialW, h: specialH,
    seats: [{ x: (debugX + 3) * TILE_SIZE, y: (meetingY + 3) * TILE_SIZE, id: 'debug_0' }],
  });

  // Fill remaining gaps with floor
  for (let row = 0; row < totalH; row++) {
    for (let col = 0; col < totalW; col++) {
      if (map[row][col] === TILE.EMPTY) {
        if (row > 0 && row < totalH - 1 && col > 0 && col < totalW - 1) {
          map[row][col] = TILE.FLOOR;
        }
      }
    }
  }

  rooms.push({
    id: 'public',
    type: 'public',
    label: '公共区域',
    x: ROOM_PADDING, y: entranceY + specialH,
    w: totalW - ROOM_PADDING * 2, h: HALL_HEIGHT,
    seats: Array.from({ length: 6 }, (_, i) => ({
      x: (4 + i * 3) * TILE_SIZE,
      y: (entranceY + specialH + 1) * TILE_SIZE,
      id: `public_${i}`,
    })),
  });

  return {
    mapWidth: totalW,
    mapHeight: totalH,
    tileData: map,
    rooms,
  };
}

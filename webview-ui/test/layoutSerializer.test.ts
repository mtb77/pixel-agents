/**
 * Tests for the `migrateLayoutColors` migration path (which wraps
 * the internal `migrateLayout` function — the only public migration entrypoint).
 *
 * Focused on the pet-system extension: legacy layouts (no `pets` field)
 * must be migrated to include `pets: []`. Layouts with existing `pets`
 * must preserve them unchanged.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ColorValue } from '../src/components/ui/types.js';
import { reconcileExistingAgents } from '../src/office/engine/existingAgents.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import { layoutToSeats, migrateLayoutColors } from '../src/office/layout/layoutSerializer.js';
import type { OfficeLayout, PlacedFurniture, PlacedPet } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

const sprite = [['']];
buildDynamicCatalog({
  catalog: [
    {
      id: 'WOODEN_CHAIR',
      label: 'Wooden Chair',
      category: 'chairs',
      width: 1,
      height: 1,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      orientation: 'back',
    },
    {
      id: 'SOFA',
      label: 'Sofa',
      category: 'chairs',
      width: 2,
      height: 1,
      footprintW: 2,
      footprintH: 1,
      isDesk: false,
      orientation: 'front',
    },
    ...['DESK', 'TABLE_FRONT', 'COFFEE_TABLE'].map((id) => ({
      id,
      label: id,
      category: 'desks',
      width: 1,
      height: 1,
      footprintW: 1,
      footprintH: 1,
      isDesk: true,
    })),
    {
      id: 'PC',
      label: 'PC',
      category: 'electronics',
      width: 1,
      height: 1,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      canPlaceOnSurfaces: true,
    },
  ],
  sprites: {
    WOODEN_CHAIR: sprite,
    SOFA: sprite,
    DESK: sprite,
    TABLE_FRONT: sprite,
    COFFEE_TABLE: sprite,
    PC: sprite,
  },
});

// ── Helpers ────────────────────────────────────────────────────

function baseLayout(overrides: Partial<OfficeLayout> = {}): OfficeLayout {
  // 4×3 minimum layout. layoutRevision = 1 to skip the OLD_VOID branch and
  // tileColors length-match to skip the tileColors-generation early return.
  const cols = 4;
  const rows = 3;
  const tiles = new Array(cols * rows).fill(TileType.FLOOR_1);
  const tileColors: Array<ColorValue | null> = new Array(cols * rows).fill(null);
  return {
    version: 1,
    cols,
    rows,
    tiles,
    furniture: [],
    tileColors,
    layoutRevision: 1,
    ...overrides,
  };
}

// ── Migration: pets field absent ──────────────────────────────

test('migrateLayoutColors injects pets:[] when missing on a fresh layout', () => {
  const layout = baseLayout();
  // Sanity precondition: no pets field on the input.
  assert.equal(layout.pets, undefined);
  const migrated = migrateLayoutColors(layout);
  assert.deepEqual(migrated.pets, []);
});

test('migrateLayoutColors injects pets:[] even when tileColors triggers the early-return path', () => {
  // tileColors already populated with the right length → early-return guard fires.
  // The pets-default block must run BEFORE that early return.
  const layout = baseLayout(); // already has matching tileColors
  const migrated = migrateLayoutColors(layout);
  assert.deepEqual(migrated.pets, []);
});

test('migrateLayoutColors handles pets: null (corrupted JSON) by defaulting to []', () => {
  const layout = baseLayout({ pets: null as unknown as PlacedPet[] | undefined });
  const migrated = migrateLayoutColors(layout);
  assert.deepEqual(migrated.pets, []);
});

// ── Migration: pets preserved ─────────────────────────────────

test('migrateLayoutColors preserves an existing non-empty pets array', () => {
  const pets: PlacedPet[] = [
    { id: 'pet-1', petType: 0 },
    { id: 'pet-2', petType: 1 },
  ];
  const layout = baseLayout({ pets });
  const migrated = migrateLayoutColors(layout);
  assert.deepEqual(migrated.pets, pets);
});

test('migrateLayoutColors preserves an empty pets array (does not overwrite)', () => {
  const layout = baseLayout({ pets: [] });
  const migrated = migrateLayoutColors(layout);
  assert.deepEqual(migrated.pets, []);
});

// ── Migration: pets + tileColors regeneration interaction ─────

test('migrateLayoutColors injects pets:[] AND regenerates tileColors when missing', () => {
  // Force the tileColors path by stripping tileColors entirely.
  const layout: OfficeLayout = {
    version: 1,
    cols: 4,
    rows: 3,
    tiles: new Array(12).fill(TileType.FLOOR_1),
    furniture: [],
    layoutRevision: 1,
  };
  const migrated = migrateLayoutColors(layout);
  assert.deepEqual(migrated.pets, []);
  assert.ok(Array.isArray(migrated.tileColors));
  assert.equal(migrated.tileColors!.length, 12);
});

// ── Migration: OLD_VOID + pets interaction ────────────────────

test('migrateLayoutColors handles OLD_VOID tile migration AND pets:[] injection together', () => {
  // Mark as legacy: no layoutRevision, contains OLD_VOID=8.
  const cols = 4;
  const rows = 3;
  const tiles: number[] = new Array(cols * rows).fill(TileType.FLOOR_1);
  tiles[0] = 8; // OLD_VOID literal
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles: tiles as OfficeLayout['tiles'],
    furniture: [],
  };
  const migrated = migrateLayoutColors(layout);
  assert.equal(migrated.tiles[0], TileType.VOID);
  assert.deepEqual(migrated.pets, []);
});

// ── Migration: returned layout retains other fields ───────────

test('migrateLayoutColors preserves furniture and other fields untouched', () => {
  const furniture: PlacedFurniture[] = [{ uid: 'f-1', type: 'desk_basic', col: 1, row: 1 }];
  const layout = baseLayout({ furniture, pets: [{ id: 'p1', petType: 0 }] });
  const migrated = migrateLayoutColors(layout);
  assert.equal(migrated.furniture.length, 1);
  // The migrator may rewrite furniture types, so compare uid/col/row, not the
  // raw type string.
  assert.equal(migrated.furniture[0].uid, 'f-1');
  assert.equal(migrated.furniture[0].col, 1);
  assert.equal(migrated.furniture[0].row, 1);
  assert.deepEqual(migrated.pets, [{ id: 'p1', petType: 0 }]);
  assert.equal(migrated.cols, 4);
  assert.equal(migrated.rows, 3);
  assert.equal(migrated.version, 1);
});

// ── Migration: idempotency ────────────────────────────────────

test('migrateLayoutColors is idempotent (running twice produces equivalent output)', () => {
  const layout = baseLayout();
  const once = migrateLayoutColors(layout);
  const twice = migrateLayoutColors(once);
  assert.deepEqual(twice.pets, once.pets);
  assert.deepEqual(twice.tiles, once.tiles);
  assert.deepEqual(twice.tileColors, once.tileColors);
});

test('layoutToSeats classifies only seats facing a PC as computer seats', () => {
  const furniture: PlacedFurniture[] = [
    { uid: 'computer-chair', type: 'WOODEN_CHAIR', col: 1, row: 3 },
    { uid: 'desk', type: 'DESK', col: 1, row: 2 },
    { uid: 'pc', type: 'PC', col: 1, row: 2 },
    { uid: 'table-chair', type: 'WOODEN_CHAIR', col: 4, row: 3 },
    { uid: 'table', type: 'TABLE_FRONT', col: 4, row: 2 },
    { uid: 'coffee-chair', type: 'WOODEN_CHAIR', col: 7, row: 3 },
    { uid: 'coffee-table', type: 'COFFEE_TABLE', col: 7, row: 2 },
    { uid: 'sofa', type: 'SOFA', col: 1, row: 5 },
  ];

  const seats = layoutToSeats(furniture);
  assert.equal(seats.get('computer-chair')?.hasComputer, true);
  assert.equal(seats.get('table-chair')?.hasComputer, false);
  assert.equal(seats.get('coffee-chair')?.hasComputer, false);
  assert.equal(seats.get('sofa')?.hasComputer, false);
  assert.equal(seats.get('sofa:1')?.hasComputer, false);
});

test('working agent keeps its current seat when no computer seat is free', () => {
  const cols = 7;
  const rows = 7;
  const layout = baseLayout({
    cols,
    rows,
    tiles: new Array(cols * rows).fill(TileType.FLOOR_1),
    tileColors: new Array(cols * rows).fill(null),
    furniture: [
      { uid: 'computer-chair', type: 'WOODEN_CHAIR', col: 1, row: 3 },
      { uid: 'desk', type: 'DESK', col: 1, row: 2 },
      { uid: 'pc', type: 'PC', col: 1, row: 2 },
      { uid: 'plain-chair', type: 'WOODEN_CHAIR', col: 5, row: 3 },
    ],
  });
  const office = new OfficeState(layout);
  office.addAgent(1, 0, 0, 'computer-chair', true);
  office.addAgent(2, 1, 0, 'plain-chair', true);
  office.setAgentActive(1, true);
  const agent = office.characters.get(2)!;

  office.setAgentActive(2, true);
  office.update(5.1);

  assert.equal(agent.seatId, 'plain-chair');
  assert.equal(office.seats.get('plain-chair')?.assigned, true);
  assert.equal(office.seats.get('computer-chair')?.assigned, true);
});

test('agent created while idle releases its initially assigned seat', () => {
  const layout = baseLayout({
    furniture: [{ uid: 'chair', type: 'WOODEN_CHAIR', col: 1, row: 1 }],
  });
  const office = new OfficeState(layout);

  office.addAgent(1, 0, 0, 'chair', true);
  office.update(5.1);

  assert.equal(office.characters.get(1)?.seatId, null);
  assert.equal(office.seats.get('chair')?.assigned, false);
});

test('idle agent restored through existingAgents releases its persisted seat', () => {
  const layout = baseLayout({
    furniture: [{ uid: 'chair', type: 'WOODEN_CHAIR', col: 1, row: 1 }],
  });
  const office = new OfficeState(layout);
  const pending: Parameters<typeof reconcileExistingAgents>[5] = [];

  const added = reconcileExistingAgents(
    office,
    [7],
    { 7: { palette: 0, hueShift: 0, seatId: 'chair' } },
    {},
    true,
    pending,
  );
  office.update(5.1);

  assert.equal(added, true);
  assert.equal(office.characters.get(7)?.seatId, null);
  assert.equal(office.seats.get('chair')?.assigned, false);
});

test('working agent created at a plain table moves to a computer seat', () => {
  const cols = 7;
  const rows = 7;
  const layout = baseLayout({
    cols,
    rows,
    tiles: new Array(cols * rows).fill(TileType.FLOOR_1),
    tileColors: new Array(cols * rows).fill(null),
    furniture: [
      { uid: 'computer-chair', type: 'WOODEN_CHAIR', col: 1, row: 3 },
      { uid: 'pc', type: 'PC', col: 1, row: 2 },
      { uid: 'plain-chair', type: 'WOODEN_CHAIR', col: 5, row: 3 },
    ],
  });
  const office = new OfficeState(layout);
  office.addAgent(1, 0, 0, 'plain-chair', true);

  office.setAgentActive(1, true);
  office.update(5.1);

  assert.equal(office.characters.get(1)?.seatId, 'computer-chair');
  assert.equal(office.seats.get('plain-chair')?.assigned, false);
  assert.equal(office.seats.get('computer-chair')?.assigned, true);
});

test('working existingAgent keeps its persisted computer seat', () => {
  const layout = baseLayout({
    furniture: [
      { uid: 'chair', type: 'WOODEN_CHAIR', col: 1, row: 2 },
      { uid: 'pc', type: 'PC', col: 1, row: 1 },
    ],
  });
  const office = new OfficeState(layout);
  const pending: Parameters<typeof reconcileExistingAgents>[5] = [];
  reconcileExistingAgents(
    office,
    [7],
    { 7: { palette: 0, hueShift: 0, seatId: 'chair' } },
    {},
    true,
    pending,
  );

  office.setAgentActive(7, true);
  office.update(5.1);

  assert.equal(office.characters.get(7)?.seatId, 'chair');
  assert.equal(office.seats.get('chair')?.assigned, true);
});

test('stable idle transition releases the seat and walks the agent to stand', () => {
  const cols = 7;
  const rows = 7;
  const layout = baseLayout({
    cols,
    rows,
    tiles: new Array(cols * rows).fill(TileType.FLOOR_1),
    tileColors: new Array(cols * rows).fill(null),
    furniture: [{ uid: 'chair', type: 'WOODEN_CHAIR', col: 3, row: 3 }],
  });
  const office = new OfficeState(layout);
  office.addAgent(1, 0, 0, 'chair', true);

  office.setAgentActive(1, false);
  office.update(4.9);
  assert.equal(office.characters.get(1)?.seatId, 'chair');

  office.update(0.2);
  const agent = office.characters.get(1)!;
  assert.equal(agent.seatId, null);
  assert.equal(office.seats.get('chair')?.assigned, false);
  assert.equal(agent.state, 'walk');
  assert.ok(agent.path.length > 0);
});

test('brief idle flicker does not make a working agent leave its seat', () => {
  const layout = baseLayout({
    furniture: [{ uid: 'chair', type: 'WOODEN_CHAIR', col: 1, row: 1 }],
  });
  const office = new OfficeState(layout);
  office.addAgent(1, 0, 0, 'chair', true);

  office.setAgentActive(1, false);
  office.update(2);
  office.setAgentActive(1, true);
  office.update(5.1);

  assert.equal(office.characters.get(1)?.seatId, 'chair');
  assert.equal(office.seats.get('chair')?.assigned, true);
});

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseOpenAPI } from '@readme/openapi-parser'
import type { IrObject } from '../../src/schema-codegen/ir.ts'
import { refName, toIr } from '../../src/schema-codegen/normalize.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')

describe('schema-codegen / normalize', () => {
  describe('refName', () => {
    it('extracts a component schema name', () => {
      assert.equal(refName('#/components/schemas/Pet'), 'Pet')
    })
    it('decodes JSON-pointer escapes', () => {
      assert.equal(refName('#/components/schemas/A~1B'), 'A/B')
    })
    it('returns undefined for foreign refs', () => {
      assert.equal(refName('other.yaml#/X'), undefined)
    })
  })

  describe('scalars', () => {
    it('maps integer with format and bounds', () => {
      const ir = toIr({ type: 'integer', format: 'int64', minimum: 1, maximum: 100 })
      assert.deepEqual(ir, {
        kind: 'scalar',
        type: 'integer',
        format: 'int64',
        constraints: { minimum: 1, maximum: 100 },
      })
    })

    it('normalizes 3.0 boolean exclusiveMinimum to the boundary value', () => {
      const ir = toIr({ type: 'number', minimum: 0, exclusiveMinimum: true })
      assert.deepEqual(ir, {
        kind: 'scalar',
        type: 'number',
        constraints: { exclusiveMinimum: 0 },
      })
    })

    it('keeps 3.1 numeric exclusiveMaximum as-is', () => {
      const ir = toIr({ type: 'number', exclusiveMaximum: 10 })
      assert.deepEqual(ir, {
        kind: 'scalar',
        type: 'number',
        constraints: { exclusiveMaximum: 10 },
      })
    })
  })

  describe('nullability', () => {
    it('reads 3.0 nullable', () => {
      const ir = toIr({ type: 'string', nullable: true })
      assert.equal(ir.kind, 'scalar')
      assert.equal(ir.nullable, true)
    })

    it('reads 3.1 type array with null', () => {
      const ir = toIr({ type: ['string', 'null'] })
      assert.equal(ir.kind, 'scalar')
      assert.equal(ir.nullable, true)
    })

    it('turns multiple non-null types into a union', () => {
      const ir = toIr({ type: ['string', 'integer'] })
      assert.equal(ir.kind, 'union')
      if (ir.kind !== 'union') throw new Error('unreachable')
      assert.deepEqual(
        ir.options.map((o) => o.kind),
        ['scalar', 'scalar'],
      )
    })
  })

  describe('enum / const', () => {
    it('maps a string enum and lifts null into nullable', () => {
      const ir = toIr({ type: 'string', enum: ['a', 'b', null] })
      assert.deepEqual(ir, { kind: 'enum', values: ['a', 'b'], base: 'string', nullable: true })
    })
    it('maps const to a single-value enum', () => {
      const ir = toIr({ const: 'fixed' })
      assert.deepEqual(ir, { kind: 'enum', values: ['fixed'], base: 'string' })
    })
  })

  describe('composition', () => {
    it('maps allOf to an allOf node preserving parts', () => {
      const ir = toIr({
        allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object' }],
      })
      assert.equal(ir.kind, 'allOf')
      if (ir.kind !== 'allOf') throw new Error('unreachable')
      assert.equal(ir.parts[0].kind, 'ref')
      assert.equal(ir.parts[1].kind, 'object')
    })

    it('maps oneOf to a union with discriminator', () => {
      const ir = toIr({
        oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
        discriminator: { propertyName: 'petType' },
      })
      assert.equal(ir.kind, 'union')
      if (ir.kind !== 'union') throw new Error('unreachable')
      assert.equal(ir.discriminator, 'petType')
      assert.equal(ir.options.length, 2)
    })
  })

  describe('objects and arrays', () => {
    it('records required vs optional properties', () => {
      const ir = toIr({
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' }, tag: { type: 'string' } },
      }) as IrObject
      assert.equal(ir.kind, 'object')
      const byName = Object.fromEntries(ir.properties.map((p) => [p.name, p.required]))
      assert.deepEqual(byName, { id: true, tag: false })
    })

    it('records additionalProperties: false as a closed object', () => {
      const ir = toIr({ type: 'object', additionalProperties: false }) as IrObject
      assert.equal(ir.additional, false)
    })

    it('maps a typed additionalProperties to a record schema', () => {
      const ir = toIr({ type: 'object', additionalProperties: { type: 'string' } }) as IrObject
      assert.deepEqual(ir.additional, { kind: 'scalar', type: 'string' })
    })

    it('maps array items', () => {
      const ir = toIr({ type: 'array', items: { $ref: '#/components/schemas/Pet' } })
      assert.equal(ir.kind, 'array')
      if (ir.kind !== 'array') throw new Error('unreachable')
      assert.deepEqual(ir.items, { kind: 'ref', name: 'Pet' })
    })
  })

  describe('petstore fixture', () => {
    it('normalizes Pet / Pets / Error from components.schemas', async () => {
      const api = (await parseOpenAPI(join(FIXTURES, 'petstore-3.0.yaml'))) as unknown as {
        components: { schemas: Record<string, unknown> }
      }
      const schemas = api.components.schemas

      const pet = toIr(schemas.Pet) as IrObject
      assert.equal(pet.kind, 'object')
      const id = pet.properties.find((p) => p.name === 'id')
      assert.deepEqual(id, {
        name: 'id',
        required: true,
        schema: { kind: 'scalar', type: 'integer', format: 'int64' },
      })
      const tag = pet.properties.find((p) => p.name === 'tag')
      assert.equal(tag?.required, false)

      const pets = toIr(schemas.Pets)
      assert.deepEqual(pets, { kind: 'array', items: { kind: 'ref', name: 'Pet' } })

      const error = toIr(schemas.Error) as IrObject
      assert.equal(error.kind, 'object')
      assert.equal(error.properties.find((p) => p.name === 'code')?.required, true)
    })
  })
})

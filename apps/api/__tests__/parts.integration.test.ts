/**
 * Parts module integration test. The TME-backed PartProvider is mocked, so this needs no live
 * TME calls and no database — it verifies the HTTP surface, validation, and component mapping.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { PartsModule } from '../src/parts/parts.module';
import { PART_PROVIDER, type PartProvider } from '../src/parts/provider/part-provider.interface';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';

describe('Parts (integration, TME mocked)', () => {
    let app: INestApplication;
    const provider: jest.Mocked<PartProvider> = {
        name: 'mock',
        search: jest.fn(),
        getManufacturers: jest.fn(),
        getCategories: jest.fn(),
        getProduct: jest.fn(),
    };

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({
            imports: [ConfigModule.forRoot({ isGlobal: true }), PartsModule],
        })
            .overrideProvider(PART_PROVIDER)
            .useValue(provider)
            .overrideGuard(JwtAuthGuard)
            .useValue({ canActivate: () => true })
            .compile();

        app = moduleRef.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
        await app.init();
    });

    afterAll(async () => {
        await app?.close();
    });

    beforeEach(() => jest.clearAllMocks());

    it('GET /parts/search returns provider results', async () => {
        provider.search.mockResolvedValue({
            items: [
                {
                    mpn: 'NE555P',
                    manufacturer: 'TEXAS INSTRUMENTS',
                    description: 'timer',
                    parameters: [],
                    priceBreaks: [],
                    supplier: 'tme',
                    supplierId: 'NE555P',
                },
            ],
            page: 1,
            pageSize: 1,
        });
        const res = await request(app.getHttpServer()).get('/parts/search?q=NE555-unique-1').expect(200);
        expect(res.body.items[0].mpn).toBe('NE555P');
        expect(provider.search).toHaveBeenCalledWith(expect.objectContaining({ q: 'NE555-unique-1' }));
    });

    it('GET /parts/search returns 400 without q', async () => {
        await request(app.getHttpServer()).get('/parts/search').expect(400);
    });

    it('GET /parts/manufacturers returns the facet', async () => {
        provider.getManufacturers.mockResolvedValue([{ id: '77', name: 'TEXAS INSTRUMENTS', productsCount: 25119 }]);
        const res = await request(app.getHttpServer()).get('/parts/manufacturers').expect(200);
        expect(res.body[0].name).toBe('TEXAS INSTRUMENTS');
    });

    it('GET /parts/:symbol/component flags an IC as not simulatable', async () => {
        provider.getProduct.mockResolvedValue({
            mpn: 'NE555P',
            manufacturer: 'TI',
            description: 'IC: RC timer',
            category: 'Watchdog and reset circuits',
            parameters: [],
            priceBreaks: [],
            supplier: 'tme',
            supplierId: 'NE555P',
        });
        const res = await request(app.getHttpServer()).get('/parts/NE555P/component').expect(200);
        expect(res.body.simulatable).toBe(false);
    });

    it('GET /parts/:symbol/component maps a resistor', async () => {
        provider.getProduct.mockResolvedValue({
            mpn: '0603WAF1002T5E',
            manufacturer: 'UNI-ROYAL',
            description: '',
            category: 'Resistors',
            footprint: '0603',
            parameters: [{ name: 'Resistance', value: '10kΩ' }],
            priceBreaks: [],
            supplier: 'tme',
            supplierId: 'C25804',
            unitCost: 0.0017,
            currency: 'EUR',
            stock: 9,
        });
        const res = await request(app.getHttpServer()).get('/parts/C25804/component').expect(200);
        expect(res.body.simulatable).toBe(true);
        expect(res.body.component.type).toBe('resistor');
        expect(res.body.component.value).toBe('10K');
        expect(res.body.component.sourcing.supplierId).toBe('C25804');
    });
});

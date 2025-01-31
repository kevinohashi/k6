import http from 'k6/http'
import { check, group, fail, sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'

import faker from 'https://cdn.jsdelivr.net/npm/faker@5.5.3/dist/faker.min.js'

import { rand, sample, wpMetrics, responseWasCached, bypassPageCacheCookies } from './lib/helpers.js'
import { isOK, itemAddedToCart, cartHasProduct, orderWasPlaced } from './lib/checks.js'

export const options = {
    throw: true,
    scenarios: {
        ramping: {
            executor: 'ramping-vus',
            startVUs: 1,
            gracefulStop: '10s',
            gracefulRampDown: '10s',
            stages: [
                { duration: '1m', target: 100 },
            ],
        },
        // constant: {
        //     executor: 'constant-vus',
        //     vus: 100,
        //     duration: '1m',
        //     gracefulStop: '10s',
        // },
    },
}

const errorRate = new Rate('errors')
const responseCacheRate = new Rate('response_cached')

// metrics provided by Object Cache Pro
const cacheHits = new Trend('cache_hits')
const storeReads = new Trend('store_reads')
const storeWrites = new Trend('store_writes')
const msCache = new Trend('ms_cache', true)
const msCacheRatio = new Trend('ms_cache_ratio')

export default function () {
    let metrics

    const jar = new http.CookieJar()
    const siteUrl = __ENV.SITE_URL || 'https://test.cachewerk.com'

    const pause = {
        min: 3,
        max: 8,
    }

    const addResponseMetrics = (response) => {
        responseCacheRate.add(responseWasCached(response))

        if (metrics = wpMetrics(response)) {
            cacheHits.add(metrics.hits)
            storeReads.add(metrics.storeReads)
            storeWrites.add(metrics.storeWrites)
            msCache.add(metrics.msCache)
            msCacheRatio.add(metrics.msCacheRatio)
        }
    }

    if (__ENV.BYPASS_CACHE) {
        Object.entries(bypassPageCacheCookies()).forEach(([key, value]) => {
            jar.set(siteUrl, key, value, { path: '/' })
        })
    }

    const categories = group('Load homepage', function () {
        const response = http.get(siteUrl, { jar })

        check(response, isOK)
            || (errorRate.add(1) && fail('status code was *not* 200'))

        addResponseMetrics(response)

        return response.html()
            .find('li.product-category > a')
            .map((idx, el) => String(el.attr('href')))
            .filter(href => ! href.includes('/decor/')) // skip WP swag
    })

    sleep(rand(pause.min, pause.max))

    const products = group('Load category', function () {
        const category = sample(categories)
        const response = http.get(category, { jar })

        check(response, isOK)
            || (errorRate.add(1) && fail('status code was *not* 200'))

        addResponseMetrics(response)

        return response.html()
            .find('.products')
            .find('.product:not(.product-type-variable)') // skip variable products
            .find('.woocommerce-loop-product__link')
            .map((idx, el) => el.attr('href'))
    })

    sleep(rand(pause.min, pause.max))

    group('Load and add product to cart', function () {
        const product = sample(products)
        const response = http.get(product, { jar })

        check(response, isOK)
            || (errorRate.add(1) && fail('status code was *not* 200'))

        addResponseMetrics(response)

        const fields = response.html()
            .find('.input-text.qty')
            .map((idx, el) => el.attr('name'))
            .reduce((obj, key) => {
                obj[key] = 1

                return obj
            }, {})

        const formResponse = response.submitForm({
            formSelector: 'form.cart',
            fields,
            params: { jar },
        })

        check(formResponse, isOK)
            || (errorRate.add(1) && fail('status code was *not* 200'))

        check(formResponse, itemAddedToCart)
            || fail('items *not* added to cart')

        addResponseMetrics(formResponse)
    })

    sleep(rand(pause.min, pause.max))

    group('Load cart', function () {
        const response = http.get(`${siteUrl}/cart`, { jar })

        check(response, isOK)
            || (errorRate.add(1) && fail('status code was *not* 200'))

        check(response, cartHasProduct)
            || fail('cart was empty')

        addResponseMetrics(response)
    })

    sleep(rand(pause.min, pause.max))

    group('Place holder', function () {
        const response = http.get(`${siteUrl}/checkout`, { jar })

        check(response, isOK)
            || (errorRate.add(1) && fail('status code was *not* 200'))

        addResponseMetrics(response)

        const fields = {
            billing_first_name: faker.name.firstName(),
            billing_last_name: faker.name.lastName(),
            billing_company: faker.datatype.boolean() ? faker.company.companyName() : null,
            billing_country: 'US',
            billing_state: faker.address.stateAbbr(),
            billing_address_1: faker.address.streetAddress(),
            billing_address_2: faker.datatype.boolean() ? faker.address.secondaryAddress() : null,
            billing_city: faker.address.city(),
            billing_postcode: faker.address.zipCodeByState('DE'),
            billing_phone: faker.phone.phoneNumberFormat(),
            billing_email: rand(1, 100) + '-' + faker.internet.exampleEmail(),
            order_comments: faker.datatype.boolean() ? faker.lorem.sentences() : null,
        }

        const formResponse = response.submitForm({
            formSelector: 'form[name="checkout"]',
            params: { jar },
            fields,
        })

        check(formResponse, orderWasPlaced)
            || fail('order was *not* placed')

        addResponseMetrics(formResponse)
    })
}

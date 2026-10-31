import unittest
from types import SimpleNamespace
from steve_desktop import cad_service
from steve.reporting_cache import MemoryAreaCache


class ReportingMemoryTests(unittest.TestCase):
    def test_byte_budget_oversized_values_and_memory_pressure(self):
        now=[0.0]
        memory=SimpleNamespace(total=16000,available=17600)  # 1,000-byte allowance
        calls=[]
        cache=MemoryAreaCache(lambda key:calls.append(key) or len(key),
            memory_provider=lambda:memory,workers=1,clock=lambda:now[0])
        self.assertEqual(cache('small'),5)
        self.assertEqual(cache('small'),5)
        self.assertEqual(calls,['small'])
        large='x'*2000
        self.assertEqual(cache(large),2000)
        self.assertEqual(cache(large),2000)
        self.assertEqual(cache.cache_info()['entries'],1)
        self.assertLessEqual(cache.cache_info()['bytes'],cache.cache_info()['budget_bytes'])
        memory.available=1000;now[0]=2
        self.assertEqual(cache.cache_info()['entries'],0)
        self.assertEqual(cache.cache_info()['bytes'],0)
        self.assertEqual(cache('small'),5)
        memory.available=17600;now[0]=4
        self.assertEqual(cache('small'),5)
        self.assertEqual(cache.cache_info()['entries'],1)

    def test_budget_shared_between_workers_and_lru_eviction(self):
        memory=SimpleNamespace(total=16000,available=161600)
        one=MemoryAreaCache(len,memory_provider=lambda:memory,workers=1)
        four=MemoryAreaCache(len,memory_provider=lambda:memory,workers=4)
        self.assertEqual(one.cache_info()['budget_bytes'],4*four.cache_info()['budget_bytes'])
        for index in range(100):four(str(index)*100)
        state=four.cache_info()
        self.assertGreater(state['entries'],0)
        self.assertLess(state['entries'],100)
        self.assertLessEqual(state['bytes'],state['budget_bytes'])
        hits=state['hits'];four('99'*100)
        self.assertEqual(four.cache_info()['hits'],hits+1)
        four.cache_clear()
        self.assertEqual(four.cache_info()['bytes'],0)

    def test_missing_memory_telemetry_disables_cache_without_failing_calculation(self):
        def missing():raise OSError('unavailable')
        cache=MemoryAreaCache(len,memory_provider=missing)
        self.assertEqual(cache('geometry'),8)
        self.assertEqual(cache.cache_info()['entries'],0)

if __name__=='__main__':unittest.main()

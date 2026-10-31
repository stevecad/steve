"""RAM-budgeted area results for a disposable local CAD worker.

Account for Python keys, wrappers, values and the actual OrderedDict storage.
Native B-reps are shared with the live model, not copied by this cache; OS memory
pressure also constrains retention. This is a cache budget, not a model limit.
"""
from collections import OrderedDict
from functools import update_wrapper
import os
import sys
import threading
import time
import psutil


class MemoryAreaCache:
    def __init__(self, function, *, memory_provider=psutil.virtual_memory, workers=None, clock=time.monotonic):
        update_wrapper(self,function)
        self.function=function
        self.memory_provider=memory_provider
        self.workers=workers
        self.clock=clock
        self.lock=threading.RLock()
        self.data=OrderedDict()
        self.payload_bytes=0
        self.limit=0
        self.worker_count=0
        self.sample_at=float('-inf')
        self.hits=self.misses=0

    def _sample(self):
        now=self.clock()
        if now-self.sample_at<1:return
        self.sample_at=now
        try:
            memory=self.memory_provider()
            workers=self.workers or int(os.environ.get('STEVE_AREA_CACHE_WORKERS','0'))
            if not workers:
                workers=max(1,min((os.cpu_count() or 1)*80//100,memory.total//(2*1024**3)))
            self.worker_count=max(1,workers)
            # Across the pool use at most 1/16 of currently available headroom,
            # leaving a tenth of physical RAM untouched. Shrink under pressure.
            self.limit=max(0,memory.available-memory.total//10)//(16*max(1,workers))
        except (OSError,ValueError,AttributeError):
            self.limit=0  # Missing memory telemetry must not imply unlimited RAM.
        self._trim()

    def _used(self):
        return self.payload_bytes+sys.getsizeof(self.data)

    def _trim(self):
        while self.data and self._used()>self.limit:
            _,(_,cost)=self.data.popitem(last=False)
            self.payload_bytes-=cost
        if not self.data:
            self.data.clear()  # Release the hash table's retained capacity too.
            self.payload_bytes=0

    @staticmethod
    def _cost(key,value):
        cost=sys.getsizeof(key)+sys.getsizeof(value)+sys.getsizeof((value,0))+sys.getsizeof(0)
        wrapped=getattr(key,'wrapped',None)
        if wrapped is not None:cost+=sys.getsizeof(wrapped)
        attributes=getattr(key,'__dict__',None)
        if attributes is not None:cost+=sys.getsizeof(attributes)
        return cost

    def __call__(self,key):
        with self.lock:
            self._sample()
            if key in self.data:
                self.hits+=1
                self.data.move_to_end(key)
                return self.data[key][0]
            self.misses+=1
            result=self.function(key)
            self._sample()  # Integration may have taken long enough for pressure to change.
            cost=self._cost(key,result)
            if cost+sys.getsizeof(OrderedDict())<self.limit:
                self.data[key]=(result,cost)
                self.payload_bytes+=cost
                self._trim()
            return result

    def cache_clear(self):
        with self.lock:
            self.data.clear()
            self.payload_bytes=0
            self.hits=self.misses=0
            self.sample_at=float('-inf')

    def cache_info(self):
        with self.lock:
            self._sample()
            return {'hits':self.hits,'misses':self.misses,'entries':len(self.data),
                    'bytes':self._used() if self.data else 0,'budget_bytes':self.limit,'workers':self.worker_count}

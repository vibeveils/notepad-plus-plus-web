#pragma once
#include <cstdio>
#include <cstdlib>
#include <cstring>
inline char *_itoa(int value, char *buf, int radix) {
	if (radix == 16) std::sprintf(buf, "%x", value); else std::sprintf(buf, "%d", value);
	return buf;
}

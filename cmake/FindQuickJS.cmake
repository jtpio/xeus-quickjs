#############################################################################
# Copyright (c) 2026, Jeremy Tuloup                                         #
#                                                                           #
# Distributed under the terms of the BSD 3-Clause License.                  #
#                                                                           #
# The full license is in the file LICENSE, distributed with this software.  #
#############################################################################

# Finds the QuickJS library, as installed by the quickjs package of
# conda-forge: include/quickjs/quickjs.h and lib/quickjs/libquickjs.a
#
# This module defines the following variables:
#
#   QuickJS_FOUND - true if QuickJS was found
#   QuickJS_INCLUDE_DIR - the directory containing quickjs.h
#   QuickJS_LIBRARY - the QuickJS library (including quickjs-libc)
#   QuickJS_VERSION - the version of QuickJS, e.g. 2025-09-13
#
# and the QuickJS::QuickJS imported target.

find_path(QuickJS_INCLUDE_DIR quickjs.h PATH_SUFFIXES quickjs)
find_library(QuickJS_LIBRARY NAMES quickjs PATH_SUFFIXES quickjs)
find_program(QuickJS_EXECUTABLE qjs)

if(QuickJS_EXECUTABLE AND NOT QuickJS_VERSION)
    execute_process(COMMAND ${QuickJS_EXECUTABLE} -h
                    OUTPUT_VARIABLE _quickjs_help
                    ERROR_VARIABLE _quickjs_help
                    RESULT_VARIABLE _quickjs_result)
    if(_quickjs_help MATCHES "QuickJS version ([0-9-]+)")
        set(QuickJS_VERSION "${CMAKE_MATCH_1}")
    endif()
endif()

include(FindPackageHandleStandardArgs)
find_package_handle_standard_args(QuickJS
    REQUIRED_VARS QuickJS_LIBRARY QuickJS_INCLUDE_DIR)

if(QuickJS_FOUND AND NOT TARGET QuickJS::QuickJS)
    add_library(QuickJS::QuickJS UNKNOWN IMPORTED)
    set_target_properties(QuickJS::QuickJS PROPERTIES
        IMPORTED_LOCATION "${QuickJS_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${QuickJS_INCLUDE_DIR}")
    if(UNIX)
        find_package(Threads REQUIRED)
        set_property(TARGET QuickJS::QuickJS PROPERTY
            INTERFACE_LINK_LIBRARIES m ${CMAKE_DL_LIBS} Threads::Threads)
    endif()
endif()

mark_as_advanced(QuickJS_INCLUDE_DIR QuickJS_LIBRARY QuickJS_EXECUTABLE)

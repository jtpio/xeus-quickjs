#############################################################################
# Copyright (c) 2026, Jeremy Tuloup                                         #
#                                                                           #
# Distributed under the terms of the BSD 3-Clause License.                  #
#                                                                           #
# The full license is in the file LICENSE, distributed with this software.  #
#############################################################################

cmake_minimum_required(VERSION 3.24)
project(xeus-quickjs C CXX)

set(CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake;${CMAKE_MODULE_PATH}")

set(XEUS_QUICKJS_INCLUDE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/include)

# Versionning
# ===========

file(STRINGS "${XEUS_QUICKJS_INCLUDE_DIR}/xeus-quickjs/xeus_quickjs_config.hpp" version_defines
     REGEX "#define XEUS_QUICKJS_VERSION_(MAJOR|MINOR|PATCH)")
foreach (ver ${version_defines})
    if (ver MATCHES "#define XEUS_QUICKJS_VERSION_(MAJOR|MINOR|PATCH) +([^ ]+)$")
        set(XEUS_QUICKJS_VERSION_${CMAKE_MATCH_1} "${CMAKE_MATCH_2}" CACHE INTERNAL "")
    endif ()
endforeach ()
set(${PROJECT_NAME}_VERSION
    ${XEUS_QUICKJS_VERSION_MAJOR}.${XEUS_QUICKJS_VERSION_MINOR}.${XEUS_QUICKJS_VERSION_PATCH})
message(STATUS "Building xeus-quickjs v${${PROJECT_NAME}_VERSION}")

# Configuration
# =============

include(GNUInstallDirs)

if (NOT DEFINED XEUS_QUICKJS_KERNELSPEC_PATH)
    set(XEUS_QUICKJS_KERNELSPEC_PATH "${CMAKE_INSTALL_FULL_BINDIR}/")
endif ()

configure_file (
    "${CMAKE_CURRENT_SOURCE_DIR}/share/jupyter/kernels/xquickjs/kernel.json.in"
    "${CMAKE_CURRENT_BINARY_DIR}/share/jupyter/kernels/xquickjs/kernel.json"
)

# Build options
# =============

option(XEUS_QUICKJS_BUILD_STATIC "Build xeus-quickjs static library" ON)
option(XEUS_QUICKJS_BUILD_SHARED "Split xquickjs build into executable and library" ON)
option(XEUS_QUICKJS_BUILD_EXECUTABLE "Build the xquickjs executable" ON)

option(XEUS_QUICKJS_USE_SHARED_XEUS "Link xquickjs with the xeus shared library (instead of the static library)" ON)
option(XEUS_QUICKJS_USE_SHARED_XEUS_QUICKJS "Link xquickjs with the xeus-quickjs shared library (instead of the static library)" ON)
# The native build uses an installed QuickJS, like the quickjs package of
# conda-forge. emscripten-forge has no QuickJS package yet, so the WebAssembly
# build downloads and builds it.
if (EMSCRIPTEN)
    set(XEUS_QUICKJS_USE_SYSTEM_QUICKJS_DEFAULT OFF)
else ()
    set(XEUS_QUICKJS_USE_SYSTEM_QUICKJS_DEFAULT ON)
endif ()
option(XEUS_QUICKJS_USE_SYSTEM_QUICKJS "Link with an installed QuickJS, like the quickjs package of conda-forge, instead of building it" ${XEUS_QUICKJS_USE_SYSTEM_QUICKJS_DEFAULT})

if (EMSCRIPTEN)
    # The kernel of JupyterLite is a single WebAssembly module, using xeus-lite
    message(STATUS "Building xquickjs for WebAssembly")
    # xeus is a side module, loaded by the kernel at runtime
    set_property(GLOBAL PROPERTY TARGET_SUPPORTS_SHARED_LIBS TRUE)
    set(XEUS_QUICKJS_BUILD_SHARED OFF)
    set(XEUS_QUICKJS_BUILD_STATIC ON)
    set(XEUS_QUICKJS_BUILD_EXECUTABLE OFF)
    set(XEUS_QUICKJS_USE_SHARED_XEUS_QUICKJS OFF)
    set(CMAKE_POSITION_INDEPENDENT_CODE ON)
endif ()

# Dependencies
# ============

set(xeus_REQUIRED_VERSION 6.0.0)
set(xeus-zmq_REQUIRED_VERSION 4.0.0)

find_package(xeus ${xeus_REQUIRED_VERSION} REQUIRED)

if (NOT EMSCRIPTEN)
    find_package(Threads REQUIRED)
endif ()

# QuickJS
# =======

# The release of QuickJS built from source when XEUS_QUICKJS_USE_SYSTEM_QUICKJS
# is OFF, like for the WebAssembly build.
set(XEUS_QUICKJS_QUICKJS_RELEASE "2026-06-04")
set(XEUS_QUICKJS_QUICKJS_SHA256 "b376e839b322978313d929fd20663b11ba58b75df5a46c126dd19ea2fa70ad2a")

if (XEUS_QUICKJS_USE_SYSTEM_QUICKJS)
    find_package(QuickJS REQUIRED)
    if (NOT QuickJS_VERSION)
        set(QuickJS_VERSION "unknown")
    endif ()
    message(STATUS "Found QuickJS ${QuickJS_VERSION}: ${QuickJS_LIBRARY}")
else ()
    include(FetchContent)
    FetchContent_Declare(quickjs
        URL "https://bellard.org/quickjs/quickjs-${XEUS_QUICKJS_QUICKJS_RELEASE}.tar.xz"
        URL_HASH SHA256=${XEUS_QUICKJS_QUICKJS_SHA256}
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    )
    FetchContent_MakeAvailable(quickjs)

    set(QuickJS_VERSION "${XEUS_QUICKJS_QUICKJS_RELEASE}")
    # The public headers get their own directory: on a case-insensitive file
    # system, like on macOS, the VERSION file of the sources would shadow the
    # <version> header of the C++ standard library
    set(QuickJS_INCLUDE_DIR "${CMAKE_CURRENT_BINARY_DIR}/quickjs-include")
    file(COPY ${quickjs_SOURCE_DIR}/quickjs.h ${quickjs_SOURCE_DIR}/quickjs-libc.h
         DESTINATION ${QuickJS_INCLUDE_DIR})
    message(STATUS "Building QuickJS ${QuickJS_VERSION}")

    # The objects of libquickjs.a, from the Makefile of QuickJS
    add_library(quickjs STATIC
        ${quickjs_SOURCE_DIR}/quickjs.c
        ${quickjs_SOURCE_DIR}/dtoa.c
        ${quickjs_SOURCE_DIR}/libregexp.c
        ${quickjs_SOURCE_DIR}/libunicode.c
        ${quickjs_SOURCE_DIR}/cutils.c
        ${quickjs_SOURCE_DIR}/quickjs-libc.c
    )
    target_compile_definitions(quickjs PRIVATE _GNU_SOURCE "CONFIG_VERSION=\"${QuickJS_VERSION}\"")
    set_target_properties(quickjs PROPERTIES POSITION_INDEPENDENT_CODE ON)
    if (CMAKE_C_COMPILER_ID MATCHES "Clang" OR CMAKE_C_COMPILER_ID MATCHES "GNU")
        # Third-party code, built like with its Makefile
        target_compile_options(quickjs PRIVATE -fwrapv -w)
    endif ()
    target_include_directories(quickjs SYSTEM PUBLIC
                               $<BUILD_INTERFACE:${QuickJS_INCLUDE_DIR}>
                               $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}/xeus-quickjs>)
    if (UNIX AND NOT EMSCRIPTEN)
        target_link_libraries(quickjs PUBLIC m ${CMAKE_DL_LIBS} Threads::Threads)
    endif ()
    set(XEUS_QUICKJS_QUICKJS_TARGET quickjs)
endif ()

if (XEUS_QUICKJS_USE_SYSTEM_QUICKJS)
    set(XEUS_QUICKJS_QUICKJS_TARGET $<BUILD_INTERFACE:QuickJS::QuickJS>)
endif ()

# Flags
# =====

include(CheckCXXCompilerFlag)

if (MSVC)
    add_definitions(/DNOMINMAX)
    add_compile_options(/wd4251 /wd4141)
    add_compile_options(/wd4018 /wd4267 /wd4715 /wd4146 /wd4129)
endif ()

if (CMAKE_CXX_COMPILER_ID MATCHES "Clang" OR CMAKE_CXX_COMPILER_ID MATCHES "GNU" OR CMAKE_CXX_COMPILER_ID MATCHES "Intel")
    add_compile_options($<$<COMPILE_LANGUAGE:CXX>:-Wunused-parameter> $<$<COMPILE_LANGUAGE:CXX>:-Wextra> $<$<COMPILE_LANGUAGE:CXX>:-Wreorder>)
endif ()

# Source files
# ============

set(XEUS_QUICKJS_HEADERS
    include/xeus-quickjs/xeus_quickjs_config.hpp
    include/xeus-quickjs/xinterpreter.hpp
)

set(XEUS_QUICKJS_SRC
    src/xinterpreter.cpp
)

set(XEUS_QUICKJS_MAIN_SRC
    src/main.cpp
)

set(XEUS_QUICKJS_MAIN_EMSCRIPTEN_SRC
    src/main_emscripten_kernel.cpp
)

# The JavaScript side of the kernel is embedded in the library
set(XEUS_QUICKJS_JS_SOURCES
    "runtime_js=${CMAKE_CURRENT_SOURCE_DIR}/src/js/runtime.js"
    "widgets_js=${CMAKE_CURRENT_SOURCE_DIR}/src/js/widgets.js"
    "acorn_js=${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/acorn/acorn.js"
)
set(XEUS_QUICKJS_GENERATED_DIR ${CMAKE_CURRENT_BINARY_DIR}/generated)
set(XEUS_QUICKJS_JS_HEADER ${XEUS_QUICKJS_GENERATED_DIR}/xjs_sources.hpp)

add_custom_command(
    OUTPUT ${XEUS_QUICKJS_JS_HEADER}
    COMMAND ${CMAKE_COMMAND}
            "-DOUTPUT=${XEUS_QUICKJS_JS_HEADER}"
            "-DSOURCES=${XEUS_QUICKJS_JS_SOURCES}"
            -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/xeus-quickjs-embed.cmake
    DEPENDS
        ${CMAKE_CURRENT_SOURCE_DIR}/src/js/runtime.js
        ${CMAKE_CURRENT_SOURCE_DIR}/src/js/widgets.js
        ${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/acorn/acorn.js
        ${CMAKE_CURRENT_SOURCE_DIR}/cmake/xeus-quickjs-embed.cmake
    COMMENT "Embedding the JavaScript sources of xeus-quickjs"
    VERBATIM
)
add_custom_target(xeus-quickjs-js-sources DEPENDS ${XEUS_QUICKJS_JS_HEADER})

# Targets and link - Macros
# =========================

string(TOUPPER "${CMAKE_BUILD_TYPE}" U_CMAKE_BUILD_TYPE)

set(CMAKE_INSTALL_RPATH "${CMAKE_INSTALL_PREFIX}/${CMAKE_INSTALL_LIBDIR}")

macro(xeus_quickjs_set_common_options target_name)
    target_compile_features(${target_name} PRIVATE cxx_std_17)
    set_target_properties(${target_name} PROPERTIES CXX_EXTENSIONS OFF)
endmacro()

# Common macro kernels (xquickjs)
macro(xeus_quickjs_set_kernel_options target_name)
    if (XEUS_QUICKJS_USE_SHARED_XEUS_QUICKJS)
        target_link_libraries(${target_name} PRIVATE xeus-quickjs)
        if(CMAKE_DL_LIBS)
            target_link_libraries(${target_name} PRIVATE ${CMAKE_DL_LIBS} util)
        endif()
    else ()
        target_link_libraries(${target_name} PRIVATE xeus-quickjs-static)
    endif()

    if (NOT EMSCRIPTEN)
        target_link_libraries(${target_name} PRIVATE Threads::Threads)
    endif ()
endmacro()

# Common macro for shared and static library xeus-quickjs
macro(xeus_quickjs_create_target target_name linkage output_name)
    string(TOUPPER "${linkage}" linkage_upper)

    if (NOT ${linkage_upper} MATCHES "^(SHARED|STATIC)$")
        message(FATAL_ERROR "Invalid library linkage: ${linkage}")
    endif ()

    add_library(${target_name} ${linkage_upper} ${XEUS_QUICKJS_SRC} ${XEUS_QUICKJS_HEADERS} ${XEUS_QUICKJS_JS_HEADER})
    add_dependencies(${target_name} xeus-quickjs-js-sources)
    xeus_quickjs_set_common_options(${target_name})

    set_target_properties(${target_name} PROPERTIES
                          PUBLIC_HEADER "${XEUS_QUICKJS_HEADERS}"
                          PREFIX ""
                          VERSION ${${PROJECT_NAME}_VERSION}
                          SOVERSION ${XEUS_QUICKJS_VERSION_MAJOR}
                          OUTPUT_NAME "lib${output_name}")

    target_compile_definitions(${target_name} PUBLIC "XEUS_QUICKJS_EXPORTS")
    target_compile_definitions(${target_name} PRIVATE "XEUS_QUICKJS_QUICKJS_VERSION=\"${QuickJS_VERSION}\"")

    target_include_directories(${target_name}
                               PUBLIC
                               $<BUILD_INTERFACE:${XEUS_QUICKJS_INCLUDE_DIR}>
                               $<INSTALL_INTERFACE:include>)
    target_include_directories(${target_name} PRIVATE ${XEUS_QUICKJS_GENERATED_DIR})
    # quickjs.h is part of the public interface of the interpreter: when
    # QuickJS is built, it is installed next to the headers of xeus-quickjs
    target_include_directories(${target_name} SYSTEM PUBLIC $<BUILD_INTERFACE:${QuickJS_INCLUDE_DIR}>)
    if (XEUS_QUICKJS_USE_SYSTEM_QUICKJS)
        target_include_directories(${target_name} SYSTEM PUBLIC $<INSTALL_INTERFACE:include/quickjs>)
    endif ()

    if (XEUS_QUICKJS_USE_SHARED_XEUS)
        set(XEUS_QUICKJS_XEUS_TARGET xeus)
    else ()
        set(XEUS_QUICKJS_XEUS_TARGET xeus-static)
    endif ()

    target_link_libraries(${target_name} PUBLIC ${XEUS_QUICKJS_XEUS_TARGET})
    # QuickJS is a static library, linked into xeus-quickjs
    target_link_libraries(${target_name} PRIVATE ${XEUS_QUICKJS_QUICKJS_TARGET})
    if (UNIX AND NOT EMSCRIPTEN)
        target_link_libraries(${target_name} PRIVATE m ${CMAKE_DL_LIBS} Threads::Threads)
    endif ()

    if (EMSCRIPTEN)
        xeus_wasm_compile_options(${target_name})
    endif ()
endmacro()

# xeus-quickjs
# ============

if (EMSCRIPTEN)
    include(WasmBuildOptions)
endif ()

set(XEUS_QUICKJS_TARGETS "")

if (XEUS_QUICKJS_BUILD_SHARED)
    # Build libraries
    xeus_quickjs_create_target(xeus-quickjs SHARED xeus-quickjs)
    list(APPEND XEUS_QUICKJS_TARGETS xeus-quickjs)
endif ()

if (XEUS_QUICKJS_BUILD_STATIC)
    # On Windows, a static library should use a different output name
    # to avoid the conflict with the import library of a shared one.
    if (CMAKE_HOST_WIN32)
        xeus_quickjs_create_target(xeus-quickjs-static STATIC xeus-quickjs-static)
    else ()
        xeus_quickjs_create_target(xeus-quickjs-static STATIC xeus-quickjs)
    endif ()
    list(APPEND XEUS_QUICKJS_TARGETS xeus-quickjs-static)
endif ()

# xquickjs
# ========

if (XEUS_QUICKJS_BUILD_EXECUTABLE)
    find_package(xeus-zmq ${xeus-zmq_REQUIRED_VERSION} REQUIRED)
    add_executable(xquickjs ${XEUS_QUICKJS_MAIN_SRC})
    xeus_quickjs_set_common_options(xquickjs)
    xeus_quickjs_set_kernel_options(xquickjs)
    target_link_libraries(xquickjs PRIVATE xeus-zmq)
endif()

if (EMSCRIPTEN)
    find_package(xeus-lite REQUIRED)
    add_executable(xquickjs ${XEUS_QUICKJS_MAIN_EMSCRIPTEN_SRC})
    xeus_quickjs_set_common_options(xquickjs)
    xeus_quickjs_set_kernel_options(xquickjs)
    target_link_libraries(xquickjs PRIVATE xeus-lite)
    xeus_wasm_compile_options(xquickjs)
    xeus_wasm_link_options(xquickjs "web,worker")
    # Sends what QuickJS writes on its standard streams to the notebook
    target_link_options(xquickjs PRIVATE "SHELL: --pre-js ${CMAKE_CURRENT_SOURCE_DIR}/src/emscripten/pre.js")
    set_property(TARGET xquickjs APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/emscripten/pre.js)
endif ()

# Installation
# ============

include(CMakePackageConfigHelpers)

set(XEUS_QUICKJS_CMAKECONFIG_INSTALL_DIR "${CMAKE_INSTALL_LIBDIR}/cmake/${PROJECT_NAME}" CACHE STRING "install path for xeus-quickjsConfig.cmake")

# Install xeus-quickjs and xeus-quickjs-static
if (XEUS_QUICKJS_TARGETS)
    install(TARGETS ${XEUS_QUICKJS_TARGETS}
            EXPORT ${PROJECT_NAME}-targets
            ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
            LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
            RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
            PUBLIC_HEADER DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/xeus-quickjs)

    # Makes the project importable from the build directory
    export(EXPORT ${PROJECT_NAME}-targets
           FILE "${CMAKE_CURRENT_BINARY_DIR}/${PROJECT_NAME}Targets.cmake")

    if (NOT XEUS_QUICKJS_USE_SYSTEM_QUICKJS)
        # The static library of QuickJS, used by xeus-quickjs-static
        install(TARGETS quickjs
                EXPORT ${PROJECT_NAME}-targets
                ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}/xeus-quickjs)
        install(FILES ${QuickJS_INCLUDE_DIR}/quickjs.h
                DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/xeus-quickjs)
    endif ()
endif ()

# Install xquickjs
if (XEUS_QUICKJS_BUILD_EXECUTABLE)
    install(TARGETS xquickjs
            RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
endif ()

if (EMSCRIPTEN)
    install(FILES
            "$<TARGET_FILE_DIR:xquickjs>/xquickjs.js"
            "$<TARGET_FILE_DIR:xquickjs>/xquickjs.wasm"
            DESTINATION ${CMAKE_INSTALL_BINDIR})
endif ()

if (XEUS_QUICKJS_BUILD_EXECUTABLE OR EMSCRIPTEN)
    # Configuration and data directories for jupyter and xeus-quickjs
    set(XJUPYTER_DATA_DIR "share/jupyter" CACHE STRING "Jupyter data directory")

    # Install xquickjs Jupyter kernelspec
    set(KERNELSPEC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/share/jupyter/kernels)
    install(DIRECTORY ${KERNELSPEC_DIR}
            DESTINATION ${XJUPYTER_DATA_DIR}
            PATTERN "*.in" EXCLUDE)
    install(FILES ${CMAKE_CURRENT_BINARY_DIR}/share/jupyter/kernels/xquickjs/kernel.json
            DESTINATION ${XJUPYTER_DATA_DIR}/kernels/xquickjs)

    # Extra path for installing Jupyter kernelspec
    if (XEXTRA_JUPYTER_DATA_DIR)
        install(DIRECTORY ${KERNELSPEC_DIR}
                DESTINATION ${XEXTRA_JUPYTER_DATA_DIR}
                PATTERN "*.in" EXCLUDE)
        install(FILES ${CMAKE_CURRENT_BINARY_DIR}/share/jupyter/kernels/xquickjs/kernel.json
                DESTINATION ${XEXTRA_JUPYTER_DATA_DIR}/kernels/xquickjs)
    endif ()
endif ()

# Configure 'xeus-quickjsConfig.cmake' for a build tree
set(XEUS_QUICKJS_CONFIG_CODE "####### Expanded from \@XEUS_QUICKJS_CONFIG_CODE\@ #######\n")
set(XEUS_QUICKJS_CONFIG_CODE "${XEUS_QUICKJS_CONFIG_CODE}set(CMAKE_MODULE_PATH \"${CMAKE_CURRENT_SOURCE_DIR}/cmake;\${CMAKE_MODULE_PATH}\")\n")
set(XEUS_QUICKJS_CONFIG_CODE "${XEUS_QUICKJS_CONFIG_CODE}##################################################")
configure_package_config_file(${PROJECT_NAME}Config.cmake.in
                              "${CMAKE_CURRENT_BINARY_DIR}/${PROJECT_NAME}Config.cmake"
                              INSTALL_DESTINATION ${PROJECT_BINARY_DIR})

# Configure 'xeus-quickjsConfig.cmake.in for an install tree
set(XEUS_QUICKJS_CONFIG_CODE "")
configure_package_config_file(${PROJECT_NAME}Config.cmake.in
                              "${CMAKE_CURRENT_BINARY_DIR}/CMakeFiles/${PROJECT_NAME}Config.cmake"
                              INSTALL_DESTINATION ${XEUS_QUICKJS_CMAKECONFIG_INSTALL_DIR})

write_basic_package_version_file(${CMAKE_CURRENT_BINARY_DIR}/${PROJECT_NAME}ConfigVersion.cmake
                                 VERSION ${${PROJECT_NAME}_VERSION}
                                 COMPATIBILITY AnyNewerVersion)
install(FILES ${CMAKE_CURRENT_BINARY_DIR}/CMakeFiles/${PROJECT_NAME}Config.cmake
              ${CMAKE_CURRENT_BINARY_DIR}/${PROJECT_NAME}ConfigVersion.cmake
              DESTINATION ${XEUS_QUICKJS_CMAKECONFIG_INSTALL_DIR})

if (XEUS_QUICKJS_TARGETS)
    install(EXPORT ${PROJECT_NAME}-targets
            FILE ${PROJECT_NAME}Targets.cmake
            DESTINATION ${XEUS_QUICKJS_CMAKECONFIG_INSTALL_DIR})
endif ()

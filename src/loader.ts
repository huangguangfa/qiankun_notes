/**
 * @author Kuitos
 * @since 2020-04-01
 */

import { importEntry } from 'import-html-entry';
import { concat, forEach, mergeWith } from 'lodash';
import type { LifeCycles, ParcelConfigObject } from 'single-spa';
import getAddOns from './addons';
import { QiankunError } from './error';
import { getMicroAppStateActions } from './globalState';
import type {
  FrameworkConfiguration,
  FrameworkLifeCycles,
  HTMLContentRender,
  LifeCycleFn,
  LoadableApp,
  ObjectType,
} from './interfaces';
import { createSandboxContainer, css } from './sandbox';
import {
  Deferred,
  getContainer,
  getDefaultTplWrapper,
  getWrapperId,
  isEnableScopedCSS,
  performanceMark,
  performanceMeasure,
  performanceGetEntriesByName,
  toArray,
  validateExportLifecycle,
} from './utils';

function assertElementExist(element: Element | null | undefined, msg?: string) {
  if (!element) {
    if (msg) {
      throw new QiankunError(msg);
    }

    throw new QiankunError('element not existed!');
  }
}

function execHooksChain<T extends ObjectType>(
  hooks: Array<LifeCycleFn<T>>,
  app: LoadableApp<T>,
  global = window,
): Promise<any> {
  if (hooks.length) {
    return hooks.reduce((chain, hook) => chain.then(() => hook(app, global)), Promise.resolve());
  }

  return Promise.resolve();
}

async function validateSingularMode<T extends ObjectType>(
  validate: FrameworkConfiguration['singular'],
  app: LoadableApp<T>,
): Promise<boolean> {
  return typeof validate === 'function' ? validate(app) : !!validate;
}

// 获取独立封装html
const supportShadowDOM = document.head.attachShadow || document.head.createShadowRoot;

function createElement(
  appContent: string,
  strictStyleIsolation: boolean,
  scopedCSS: boolean,
  appName: string,
): HTMLElement {
  const containerElement = document.createElement('div');
  containerElement.innerHTML = appContent;
  // appContent always wrapped with a singular div
  const appElement = containerElement.firstChild as HTMLElement;
  if (strictStyleIsolation) {
    if (!supportShadowDOM) {
      console.warn(
        '[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!',
      );
    } else {
      const { innerHTML } = appElement;
      appElement.innerHTML = '';
      let shadow: ShadowRoot;

      if (appElement.attachShadow) {
        shadow = appElement.attachShadow({ mode: 'open' });
      } else {
        // createShadowRoot was proposed in initial spec, which has then been deprecated
        shadow = (appElement as any).createShadowRoot();
      }
      shadow.innerHTML = innerHTML;
    }
  }

  if (scopedCSS) {
    const attr = appElement.getAttribute(css.QiankunCSSRewriteAttr);
    if (!attr) {
      appElement.setAttribute(css.QiankunCSSRewriteAttr, appName);
    }

    const styleNodes = appElement.querySelectorAll('style') || [];
    forEach(styleNodes, (stylesheetElement: HTMLStyleElement) => {
      css.process(appElement!, stylesheetElement, appName);
    });
  }

  return appElement;
}

/** 主要是返回应用独立的html包裹 */
function getAppWrapperGetter(
  appName: string,
  appInstanceId: string,
  useLegacyRender: boolean,
  strictStyleIsolation: boolean,
  scopedCSS: boolean,
  elementGetter: () => HTMLElement | null,
) {
  return () => {
    // use render逻辑
    if (useLegacyRender) {
      if (strictStyleIsolation) throw new QiankunError('strictStyleIsolation can not be used with legacy render!');
      if (scopedCSS) throw new QiankunError('experimentalStyleIsolation can not be used with legacy render!');

      const appWrapper = document.getElementById(getWrapperId(appInstanceId));
      assertElementExist(appWrapper, `Wrapper element for ${appName} with instance ${appInstanceId} is not existed!`);
      return appWrapper!;
    }
    // 获取应用节点
    const element = elementGetter();
    // 检查元素是否在不在就抛出异常
    assertElementExist(element, `Wrapper element for ${appName} with instance ${appInstanceId} is not existed!`);
    // 开启严格模式逻辑 、判断是否支持独立封装html
    if (strictStyleIsolation && supportShadowDOM) {
      // 返回这个封装独立的html
      return element!.shadowRoot!;
    }
    // 返回应用节点
    return element!;
  };
}

const rawAppendChild = HTMLElement.prototype.appendChild;
const rawRemoveChild = HTMLElement.prototype.removeChild;
type ElementRender = (
  props: { element: HTMLElement | null; loading: boolean; container?: string | HTMLElement },
  phase: 'loading' | 'mounting' | 'mounted' | 'unmounted',
) => any;

/**
 * Get the render function
 * If the legacy render function is provide, used as it, otherwise we will insert the app element to target container by qiankun
 * @param appName
 * @param appContent
 * @param legacyRender
 */
// render主要做应用元素节点挂载到容器节点的操作、同时做一些条件的判断比如是否用户有自己的render、如果有统一走用户的render、
function getRender(appName: string, appContent: string, legacyRender?: HTMLContentRender) {
  const render: ElementRender = ({ element, loading, container }, phase) => {
    // 如果使用use的render就直接return出去
    if (legacyRender) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(
          '[qiankun] Custom rendering function is deprecated, you can use the container element setting instead!',
        );
      }

      return legacyRender({ loading, appContent: element ? appContent : '' });
    }
    // 获取应用插入的节点dom
    const containerElement = getContainer(container!);
    // The container might have be removed after micro app unmounted.
    // Such as the micro app unmount lifecycle called by a react componentWillUnmount lifecycle, after micro app unmounted, the react component might also be removed
    // 卸载容器的报错日志
    if (phase !== 'unmounted') {
      const errorMsg = (() => {
        switch (phase) {
          case 'loading':
          case 'mounting':
            return `Target container with ${container} not existed while ${appName} ${phase}!`;

          case 'mounted':
            return `Target container with ${container} not existed after ${appName} ${phase}!`;

          default:
            return `Target container with ${container} not existed while ${appName} rendering!`;
        }
      })();
      assertElementExist(containerElement, errorMsg);
    }
    // 获取到容器元素、且当前应用元素并没有挂载到容器元素
    if (containerElement && !containerElement.contains(element)) {
      // 清空容器
      while (containerElement!.firstChild) {
        rawRemoveChild.call(containerElement, containerElement!.firstChild);
      }

      // 把应用元素插入到容器
      if (element) {
        rawAppendChild.call(containerElement, element);
      }
    }

    return undefined;
  };

  return render;
}

function getLifecyclesFromExports(
  scriptExports: LifeCycles<any>,
  appName: string,
  global: WindowProxy,
  globalLatestSetProp?: PropertyKey | null,
) {
  if (validateExportLifecycle(scriptExports)) {
    return scriptExports;
  }

  // fallback to sandbox latest set property if it had
  if (globalLatestSetProp) {
    const lifecycles = (<any>global)[globalLatestSetProp];
    if (validateExportLifecycle(lifecycles)) {
      return lifecycles;
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.warn(
      `[qiankun] lifecycle not found from ${appName} entry exports, fallback to get from window['${appName}']`,
    );
  }

  // fallback to global variable who named with ${appName} while module exports not found
  const globalVariableExports = (global as any)[appName];

  if (validateExportLifecycle(globalVariableExports)) {
    return globalVariableExports;
  }

  throw new QiankunError(`You need to export lifecycle functions in ${appName} entry`);
}

let prevAppUnmountedDeferred: Deferred<void>;

export type ParcelConfigObjectGetter = (remountContainer?: string | HTMLElement) => ParcelConfigObject;

export async function loadApp<T extends ObjectType>(
  app: LoadableApp<T>,
  configuration: FrameworkConfiguration = {},
  lifeCycles?: FrameworkLifeCycles<T>,
): Promise<ParcelConfigObjectGetter> {
  // 获取基础配置
  const { entry, name: appName } = app;
  // 创建应用id {{appName}}_1632384359678_440
  const appInstanceId = `${appName}_${+new Date()}_${Math.floor(Math.random() * 1000)}`;
  // 标记当前name
  const markName = `[qiankun] App ${appInstanceId} Loading`;
  // 生产环境 标记一下打印一些输出日志啥的
  if (process.env.NODE_ENV === 'development') {
    performanceMark(markName);
  }
  // 取出start方法参数、包含一些应用的配置比如开启沙箱、预加载其他微应用、是否为单实例场景、getPublicPath 、getTemplate ....
  const { singular = false, sandbox = true, excludeAssetFilter, ...importEntryOpts } = configuration;
  /* 
    获取入口html内容和脚本执行器 assetPublicPath='你传入的entry地址'  获取子应用资源 - import-html-entry
    template:被处理后的html模板字符串，外联的样式文件被替换为内联样式
    assetPublicPath: 静态资源的baseURL
    getExternalScripts(promise):将模板中所有script标签按照出现的先后顺序，提取出内容，组成一个数组
    getExternalStyleSheets(promise):将模板中所有link和style标签按照出现的先后顺序，提取出内容，组成一个数组
    execScripts(promise) 执行所有的script中的代码，并返回为html模板入口脚本链接entry指向的模块导出对象。
  */
  const { template, execScripts, assetPublicPath } = await importEntry(entry, importEntryOpts); // importEntry插件学习： https://blog.csdn.net/daihaoxin/article/details/106250617

  // as single-spa load and bootstrap new app parallel with other apps unmounting
  // (see https://github.com/CanopyTax/single-spa/blob/master/src/navigation/reroute.js#L74)
  // we need wait to load the app until all apps are finishing unmount in singular mode
  if (await validateSingularMode(singular, app)) {
    await (prevAppUnmountedDeferred && prevAppUnmountedDeferred.promise);
  }
  // 对应用template节点进行二次封装、包裹一层qiankun的元素
  const appContent = getDefaultTplWrapper(appInstanceId, appName)(template);
  // 是否开启严格的样式隔离模式
  const strictStyleIsolation = typeof sandbox === 'object' && !!sandbox.strictStyleIsolation;
  // 开启css隔离
  const scopedCSS = isEnableScopedCSS(sandbox);
  // 创建应用整体元素
  let initialAppWrapperElement: HTMLElement | null = createElement(
    appContent,
    strictStyleIsolation,
    scopedCSS,
    appName,
  );
  // 获取容器节点名称
  const initialContainer = 'container' in app ? app.container : undefined;
  // 判断是否存在render
  const legacyRender = 'render' in app ? app.render : undefined;
  // 获取挂载应用节点方法
  const render = getRender(appName, appContent, legacyRender);
  // 挂载应用节点到页面上
  render({ element: initialAppWrapperElement, loading: true, container: initialContainer }, 'loading');
  // 获取生成shadowRoot应用节点 或者html节点
  const initialAppWrapperGetter = getAppWrapperGetter(
    appName,
    appInstanceId,
    !!legacyRender,
    strictStyleIsolation,
    scopedCSS,
    () => initialAppWrapperElement,
  );
  // 把window赋值global
  let global = window;
  // 挂载Sandbox promise
  let mountSandbox = () => Promise.resolve();
  // 卸载Sanbox promise
  let unmountSandbox = () => Promise.resolve();
  // 校验用户在start中传入的sandbox，不传的话默认为true。如果你写成了对象，则校验有没有loose这个属性。这个loose属性我好像没有在官方文档上看到对于它的使用说明
  const useLooseSandbox = typeof sandbox === 'object' && !!sandbox.loose;
  let sandboxContainer;
  // 开始沙箱
  if (sandbox) {
    // 创建沙箱容器、传入appName(应用名称) initialAppWrapperGetter(shadowRoot应用节点 或者html节点) scopedCSS(css作用域隔离) useLooseSandbox
    sandboxContainer = createSandboxContainer(
      appName,
      // FIXME should use a strict sandbox logic while remount, see https://github.com/umijs/qiankun/issues/518
      initialAppWrapperGetter,
      scopedCSS,
      useLooseSandbox,
      excludeAssetFilter,
    );
    console.log('sandboxContainer', sandboxContainer);
    // 用沙箱的代理对象作为接下来使用的全局对象
    global = sandboxContainer.instance.proxy as typeof window;
    mountSandbox = sandboxContainer.mount;
    unmountSandbox = sandboxContainer.unmount;
  }

  const {
    beforeUnmount = [],
    afterUnmount = [],
    afterMount = [],
    beforeMount = [],
    beforeLoad = [],
  } = mergeWith({}, getAddOns(global, assetPublicPath), lifeCycles, (v1, v2) => concat(v1 ?? [], v2 ?? []));

  await execHooksChain(toArray(beforeLoad), app, global);

  // get the lifecycle hooks from module exports
  const scriptExports: any = await execScripts(global, sandbox && !useLooseSandbox);
  const { bootstrap, mount, unmount, update } = getLifecyclesFromExports(
    scriptExports,
    appName,
    global,
    sandboxContainer?.instance?.latestSetProp,
  );

  const { onGlobalStateChange, setGlobalState, offGlobalStateChange }: Record<string, CallableFunction> =
    getMicroAppStateActions(appInstanceId);

  // FIXME temporary way
  const syncAppWrapperElement2Sandbox = (element: HTMLElement | null) => (initialAppWrapperElement = element);

  const parcelConfigGetter: ParcelConfigObjectGetter = (remountContainer = initialContainer) => {
    let appWrapperElement: HTMLElement | null;
    let appWrapperGetter: ReturnType<typeof getAppWrapperGetter>;

    const parcelConfig: ParcelConfigObject = {
      name: appInstanceId,
      bootstrap,
      mount: [
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const marks = performanceGetEntriesByName(markName, 'mark');
            // mark length is zero means the app is remounting
            if (marks && !marks.length) {
              performanceMark(markName);
            }
          }
        },
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            return prevAppUnmountedDeferred.promise;
          }

          return undefined;
        },
        // initial wrapper element before app mount/remount
        async () => {
          appWrapperElement = initialAppWrapperElement;
          appWrapperGetter = getAppWrapperGetter(
            appName,
            appInstanceId,
            !!legacyRender,
            strictStyleIsolation,
            scopedCSS,
            () => appWrapperElement,
          );
        },
        // 添加 mount hook, 确保每次应用加载前容器 dom 结构已经设置完毕
        async () => {
          const useNewContainer = remountContainer !== initialContainer;
          if (useNewContainer || !appWrapperElement) {
            // element will be destroyed after unmounted, we need to recreate it if it not exist
            // or we try to remount into a new container
            appWrapperElement = createElement(appContent, strictStyleIsolation, scopedCSS, appName);
            syncAppWrapperElement2Sandbox(appWrapperElement);
          }

          render({ element: appWrapperElement, loading: true, container: remountContainer }, 'mounting');
        },
        mountSandbox,
        // exec the chain after rendering to keep the behavior with beforeLoad
        async () => execHooksChain(toArray(beforeMount), app, global),
        async (props) => mount({ ...props, container: appWrapperGetter(), setGlobalState, onGlobalStateChange }),
        // finish loading after app mounted
        async () => render({ element: appWrapperElement, loading: false, container: remountContainer }, 'mounted'),
        async () => execHooksChain(toArray(afterMount), app, global),
        // initialize the unmount defer after app mounted and resolve the defer after it unmounted
        async () => {
          if (await validateSingularMode(singular, app)) {
            prevAppUnmountedDeferred = new Deferred<void>();
          }
        },
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const measureName = `[qiankun] App ${appInstanceId} Loading Consuming`;
            performanceMeasure(measureName, markName);
          }
        },
      ],
      unmount: [
        async () => execHooksChain(toArray(beforeUnmount), app, global),
        async (props) => unmount({ ...props, container: appWrapperGetter() }),
        unmountSandbox,
        async () => execHooksChain(toArray(afterUnmount), app, global),
        async () => {
          render({ element: null, loading: false, container: remountContainer }, 'unmounted');
          offGlobalStateChange(appInstanceId);
          // for gc
          appWrapperElement = null;
          syncAppWrapperElement2Sandbox(appWrapperElement);
        },
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            prevAppUnmountedDeferred.resolve();
          }
        },
      ],
    };

    if (typeof update === 'function') {
      parcelConfig.update = update;
    }

    return parcelConfig;
  };

  return parcelConfigGetter;
}
